// Sites that fight back: Cloudflare, DataDome, PerimeterX and friends answer a robot with a
// challenge page instead of an error. Reporting that as "broken" hides the real cause (there is
// nothing to repair), so recognise it and say which wall was hit. A 200 interstitial is told
// from a real page by its size, visible text and title together, never by the title alone.

import type { RuntimeResponse } from "./runtime/request.js";
import { isJsonThrottle, isRateLimited } from "./runtime/limits.js";

export interface Challenge {
  vendor: "cloudflare" | "datadome" | "perimeterx" | "akamai" | "unknown";
  /** What gave it away, for the health report. */
  evidence: string;
  /** A check already cleared in this tab. Solving another one is the wrong next step. */
  repeat?: boolean;
}

/** The last good page, so a renamed title is not mistaken for a wall. */
export interface PageSnapshot {
  title: string;
  text: string;
  size: number;
}

/** Header names that only a bot wall sets. */
const HEADER_MARKERS: [string, Challenge["vendor"]][] = [
  ["cf-mitigated", "cloudflare"],
  ["x-datadome", "datadome"],
  ["x-px-block", "perimeterx"],
  ["x-akamai-transformed", "akamai"],
];

/** Page markers. On a 200 they also have to disagree with the last good page. */
const BODY_MARKERS: [RegExp, Challenge["vendor"], string][] = [
  [/_cf_chl_opt|cf-challenge|just a moment\.\.\./i, "cloudflare", "challenge page"],
  [/captcha-delivery\.com|geo\.captcha|datadome/i, "datadome", "captcha delivery"],
  [/px-captcha|_pxhd|perimeterx/i, "perimeterx", "px-captcha"],
  [/access denied[\s\S]{0,400}reference #\d/i, "akamai", "access denied"],
  [
    /verify (that )?you are (a )?human|are you a robot|checking your browser|unusual traffic/i,
    "unknown",
    "human check",
  ],
];

const WALL_STATUS = new Set([401, 403, 405, 406, 409, 418, 420, 429, 503]);
const phase = new Map<string, "seen" | "cleared">();
const baselines = new Map<string, PageSnapshot>();

/** Drops the per-tab challenge memory. Tests start from a browser that has not been checked. */
export function resetChallenges(): void {
  phase.clear();
  baselines.clear();
}

/** The bot wall a response came from, or undefined when it is a normal answer. */
export function detectChallenge(
  response: Pick<RuntimeResponse, "status" | "headers" | "text">,
  baseline?: PageSnapshot,
): Challenge | undefined {
  const marked = headerChallenge(response.headers);
  if (marked) return marked;
  return statusChallenge(response, baseline);
}

/**
 * Records a challenge, and a later good answer as the check having cleared.
 * The next challenge in the same tab is a repeat.
 */
export function observeExchange(
  site: string,
  response: Pick<RuntimeResponse, "status" | "headers" | "text" | "json">,
): Challenge | undefined {
  const wall = detectChallenge(response, baselines.get(site));
  if (wall) return rememberWall(site, wall);
  if (goodAnswer(response)) {
    noteSuccess(site);
    const snap = pageSnapshot(response.text);
    if (snap) baselines.set(site, snap);
  }
  return undefined;
}

const RATE_MESSAGE =
  "RATE_LIMITED: the answer is a 429 rate limit, not a change in the site. Next: wait and read again.";

/**
 * A bot check or a bare 429 body, as a failure the caller can show. Undefined when the result
 * is data. A check is not a changed shape, so the caller must not heal it.
 */
export function blockedAnswer(site: string, result: unknown): string | undefined {
  if (isJsonThrottle(result)) return RATE_MESSAGE;
  const text = answerText(result);
  if (text === undefined) {
    noteSuccess(site);
    return undefined;
  }
  const wall = detectChallenge({ status: 200, headers: {}, text }, baselines.get(site));
  if (!wall) return rememberPage(site, text);
  return challengeMessage(rememberWall(site, wall));
}

function answerText(result: unknown): string | undefined {
  if (typeof result === "string") return looksJson(result) ? undefined : result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  const html = typeof record.html === "string" ? record.html : "";
  const title = typeof record.title === "string" ? record.title : "";
  const text = typeof record.text === "string" ? record.text : "";
  const blob = `${html}\n<title>${title}</title>\n${text}`;
  return bodyChallenge(blob) ? blob : undefined;
}

function rememberPage(site: string, text: string): undefined {
  noteSuccess(site);
  const snap = pageSnapshot(text);
  if (snap) baselines.set(site, snap);
  return undefined;
}

/** What to tell the caller. A repeat names the fresh browser; the first one does not. */
export function challengeMessage(wall: Challenge): string {
  const named = `SITE_BLOCKED: A ${wall.vendor} bot wall (${wall.evidence})`;
  if (wall.repeat) return `${named}. A check already cleared in this tab; fresh browser needed.`;
  return `${named}. There is nothing to repair: open the site in a tab, clear the check like a person would, then call again.`;
}

/** Title, visible text and size of an HTML page. JSON is not a page. */
export function pageSnapshot(text: string | undefined): PageSnapshot | undefined {
  if (!text || looksJson(text)) return undefined;
  const title = titleOf(text);
  const visible = text
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!title && visible.length < 20) return undefined;
  return { title, text: visible.slice(0, 2000), size: text.length };
}

function headerChallenge(headers: RuntimeResponse["headers"] | undefined): Challenge | undefined {
  const bag = headers ?? {};
  for (const [name, vendor] of HEADER_MARKERS)
    if (bag[name]) return { vendor, evidence: `${name}: ${bag[name]}` };
  return undefined;
}

function statusChallenge(
  response: Pick<RuntimeResponse, "status" | "text">,
  baseline: PageSnapshot | undefined,
): Challenge | undefined {
  const fromBody = bodyChallenge(response.text);
  if (!fromBody) return undefined;
  if (WALL_STATUS.has(response.status)) return fromBody;
  return softPage(response, fromBody, baseline);
}

function softPage(
  response: Pick<RuntimeResponse, "status" | "text">,
  fromBody: Challenge,
  baseline: PageSnapshot | undefined,
): Challenge | undefined {
  if (response.status < 200 || response.status >= 300) return undefined;
  const page = pageSnapshot(response.text);
  if (!page) return undefined;
  if (baseline) return pageMoved(page, baseline) ? fromBody : undefined;
  return shortCheck(page) ? fromBody : undefined;
}

function bodyChallenge(text: string | undefined): Challenge | undefined {
  const slice = (text ?? "").slice(0, 60_000);
  for (const [pattern, vendor, evidence] of BODY_MARKERS)
    if (pattern.test(slice)) return { vendor, evidence: `body: ${evidence}` };
  return undefined;
}

/** Two of title, visible text and size. A new title on the same page is not a wall. */
function pageMoved(page: PageSnapshot, baseline: PageSnapshot): boolean {
  const sizeGap = Math.abs(page.size - baseline.size);
  const signals = [
    page.title !== baseline.title,
    page.text !== baseline.text,
    sizeGap > Math.max(64, baseline.size * 0.25),
  ].filter(Boolean);
  return signals.length >= 2;
}

function shortCheck(page: PageSnapshot): boolean {
  return page.text.length < 2500 || BODY_MARKERS.some(([pattern]) => pattern.test(page.title));
}

function goodAnswer(response: Pick<RuntimeResponse, "status" | "text" | "json">): boolean {
  return response.status >= 200 && response.status < 300 && !isRateLimited(response);
}

function rememberWall(site: string, wall: Challenge): Challenge {
  if (phase.get(site) !== "cleared") {
    phase.set(site, "seen");
    return wall;
  }
  return { ...wall, repeat: true };
}

function noteSuccess(site: string): void {
  if (phase.get(site) === "seen") phase.set(site, "cleared");
}

function looksJson(text: string): boolean {
  const start = text.trimStart()[0];
  return start === "{" || start === "[";
}

function titleOf(text: string): string {
  return (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
