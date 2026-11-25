// One plain sentence on why a run broke, for the person rather than a log: no codes, no stack.
// Also the I-7 rule: a vendor wall goes to the person as a captcha handoff, never to a solver.
import type { Challenge } from "./challenge.js";

export const MAX_WHY_CHARS = 180;

export type BreakageEvent =
  | { kind: "breaker"; site: string; vendor: string; until: number | Date }
  | { kind: "wall"; site: string; vendor: string }
  | { kind: "auth"; site: string; status?: number }
  | { kind: "rate-limit"; site: string; retryAfterSeconds?: number }
  | { kind: "drift"; site: string; missing?: string }
  | { kind: "network"; site: string; timeout?: boolean };

const VENDOR_NAMES: Record<string, string> = {
  cloudflare: "Cloudflare",
  datadome: "DataDome",
  perimeterx: "PerimeterX",
  akamai: "Akamai",
  kasada: "Kasada",
  unknown: "bot",
};

function vendorName(vendor: string): string {
  return VENDOR_NAMES[vendor] ?? vendor;
}

function timeOf(until: number | Date): string {
  const at = new Date(until);
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function waitPhrase(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "a little while";
  if (seconds < 120) return `${Math.ceil(seconds)} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

function sentence(event: BreakageEvent): string {
  switch (event.kind) {
    case "breaker":
      return `${event.site} tripped a ${vendorName(event.vendor)} check, so direct API calls are paused until ${timeOf(event.until)} and runs use the live page instead.`;
    case "wall":
      return `${event.site} showed a ${vendorName(event.vendor)} verification wall, so it was handed to you in Chrome instead of retrying.`;
    case "auth":
      return `${event.site} signed you out, so sign in again in Chrome and rerun it.`;
    case "rate-limit":
      return `${event.site} asked us to slow down, so try again in ${waitPhrase(event.retryAfterSeconds)}.`;
    case "drift":
      return event.missing
        ? `${event.site} changed its page and "${event.missing}" is no longer there, so this step needs updating.`
        : `${event.site} changed its page, so this step needs updating.`;
    case "network":
      return event.timeout
        ? `${event.site} took too long to answer, so check your connection and try again.`
        : `${event.site} could not be reached, so check your connection and try again.`;
  }
}

/** One sentence, at most 180 characters, ending in a full stop. */
export function explainBreakage(event: BreakageEvent): string {
  const text = sentence(event).replace(/\s+/g, " ").trim();
  if (text.length <= MAX_WHY_CHARS) return text;
  return `${text.slice(0, MAX_WHY_CHARS - 1).replace(/[\s.,]+\S*$/, "")}.`;
}

export interface CaptchaHandoff {
  kind: "captcha";
  vendor: Challenge["vendor"];
  url?: string;
  /** Never retry and never solve: the person clears the wall, then the run resumes. */
  retry: false;
  resume: "when-cleared";
  why: string;
}

/** The handoff a detected vendor wall routes to (invariant I-7). */
export function captchaHandoff(
  site: string,
  wall: Pick<Challenge, "vendor">,
  url?: string,
): CaptchaHandoff {
  const handoff: CaptchaHandoff = {
    kind: "captcha",
    vendor: wall.vendor,
    retry: false,
    resume: "when-cleared",
    why: explainBreakage({ kind: "wall", site, vendor: wall.vendor }),
  };
  if (url) handoff.url = url;
  return handoff;
}

interface ErrorLike {
  name?: string;
  message?: string;
  wall?: Challenge;
  response?: { status?: number; headers?: Record<string, string> };
}

function rateLimitOf(site: string, named: ErrorLike): BreakageEvent {
  const after = Number(named.response?.headers?.["retry-after"]);
  return Number.isFinite(after)
    ? { kind: "rate-limit", site, retryAfterSeconds: after }
    : { kind: "rate-limit", site };
}

function networkOf(site: string, named: ErrorLike): BreakageEvent | undefined {
  if (/timed? ?out|TimeoutError/i.test(`${named.name} ${named.message}`))
    return { kind: "network", site, timeout: true };
  if (/ECONN|ENOTFOUND|fetch failed|network|offline/i.test(named.message ?? ""))
    return { kind: "network", site };
  return undefined;
}

/** The breakage a site-call error stands for, from its name and status; undefined when unknown. */
export function breakageOf(site: string, error: unknown): BreakageEvent | undefined {
  if (!error || typeof error !== "object") return undefined;
  const named = error as ErrorLike;
  if (named.wall) return { kind: "wall", site, vendor: named.wall.vendor };
  const status = named.response?.status;
  if (named.name === "SignedOut" || status === 401) return { kind: "auth", site };
  if (status === 429 || /^RATE_LIMITED/.test(named.message ?? "")) return rateLimitOf(site, named);
  return networkOf(site, named);
}
