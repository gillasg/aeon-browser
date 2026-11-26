// Bot-wall, rate-limit and sign-in-wall detection, pure. page.wall() feeds it the page's facts
// (wallFacts, run in the page) and its recorded requests. Embedded in the sandbox by source
// (code-api-posthoc-net.ts): self-contained, calling only this file's functions by name.

export type WallKind =
  | "cloudflare"
  | "vercel"
  | "aws-waf"
  | "akamai"
  | "datadome"
  | "perimeterx"
  | "rate-limit"
  | "login"
  | "waf";

export interface WallFacts {
  url: string;
  title: string;
  text: string;
  textLength: number;
  markers: string[];
  password: boolean;
}

export interface WallEntry {
  url: string;
  method?: string;
  type?: string;
  status?: number;
}

export interface Wall {
  blocked: boolean;
  kind: WallKind | null;
  status: number | null;
  signal: string | null;
  partial: Array<{ url: string; status: number; kind: WallKind }>;
}

/** Runs in the page: title, a bounded text sample, vendor markers and whether a password field shows. */
export function wallFacts(): WallFacts {
  const probes: Array<[string, string]> = [
    [
      "#cf-challenge-running, #challenge-running, #challenge-form, .cf-turnstile, #cf-wrapper",
      "cloudflare",
    ],
    [
      "script[src*='challenges.cloudflare.com'], iframe[src*='challenges.cloudflare.com']",
      "cloudflare",
    ],
    ["#px-captcha, script[src*='px-cdn'], script[src*='perimeterx']", "perimeterx"],
    ["iframe[src*='captcha-delivery.com'], script[src*='captcha-delivery.com']", "datadome"],
    ["script[src*='awswaf'], script[src*='token.awswaf.com'], #aws-waf-token", "aws-waf"],
  ];
  const markers: string[] = [];
  for (const [selector, kind] of probes)
    if (document.querySelector(selector) && !markers.includes(kind)) markers.push(kind);
  if (/__cf_chl_(rt_)?tk|__cf_chl_/.test(location.href)) markers.push("cloudflare");
  const text = String((document.body && document.body.innerText) || "");
  return {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 2000),
    textLength: text.length,
    markers,
    password: !!document.querySelector("input[type=password]"),
  };
}

/** The kind named by the title or a short body's text, if any. */
export function wallTextKind(facts: WallFacts): WallKind | null {
  const WALL_TEXT: Array<[RegExp, WallKind]> = [
    [/^just a moment|^attention required|^checking your browser/i, "cloudflare"],
    [/vercel security checkpoint/i, "vercel"],
    [/pardon our interruption/i, "akamai"],
    [
      /not able to serve your requests this quickly|too many requests|you are being rate.?limited|rate limit exceeded/i,
      "rate-limit",
    ],
    [
      /blocked by network security|access denied|request blocked|you have been blocked|forbidden/i,
      "waf",
    ],
  ];
  for (const [pattern, kind] of WALL_TEXT) if (pattern.test(facts.title.trim())) return kind;
  if (facts.textLength > 3000) return null;
  for (const [pattern, kind] of WALL_TEXT) if (pattern.test(facts.text)) return kind;
  return null;
}

/** A status worth calling a wall, and the kind it implies on its own. */
export function wallStatusKind(status: number | undefined): WallKind | null {
  if (status === 708) return "vercel";
  if (status === 429) return "rate-limit";
  if (status === 403 || status === 503) return "waf";
  return null;
}

export function wallPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + (parsed.search ? "?…" : "");
  } catch {
    return url.slice(0, 120);
  }
}

/** The main document: the latest Document request for the page's URL, else the latest Document. */
export function wallMainDoc(facts: WallFacts, entries: WallEntry[]): WallEntry | undefined {
  const docs = entries.filter((entry) => entry.type === "Document");
  const bare = (url: string) => url.split("#")[0];
  return docs.filter((entry) => bare(entry.url) === bare(facts.url)).pop() || docs[docs.length - 1];
}

/** Sub-requests to the site's data endpoints that a wall answered (403, 429, 708, 503). */
export function wallPartial(entries: WallEntry[], main?: WallEntry): Wall["partial"] {
  const partial: Wall["partial"] = [];
  for (const entry of entries) {
    if (entry === main || entry.type === "Document" || entry.status === undefined) continue;
    const kind = /\/\.well-known\/vercel\/security\//.test(entry.url)
      ? "vercel"
      : wallStatusKind(entry.status);
    if (!kind) continue;
    const data = /\/(csi|esi|graphql|gql|api|ajax|_next\/data)(\/|\?|$)|\.json(\?|$)/i.test(
      entry.url,
    );
    if (!data && entry.type !== "Fetch" && entry.type !== "XHR" && kind !== "vercel") continue;
    if (partial.length < 10)
      partial.push({ url: entry.url.slice(0, 300), status: entry.status, kind });
  }
  return partial;
}

export function wallLogin(facts: WallFacts): boolean {
  let path = "";
  try {
    path = new URL(facts.url).pathname;
  } catch {
    return false;
  }
  return (
    facts.password && facts.textLength < 1500 && /\/(log-?in|sign-?in|auth|session)s?\b/i.test(path)
  );
}

/** Combines the page facts and the recording into one verdict. */
export function wallDetect(facts: WallFacts, entries: WallEntry[]): Wall {
  const main = wallMainDoc(facts, entries);
  const status = main && typeof main.status === "number" ? main.status : null;
  const partial = wallPartial(entries, main);
  const verdict = (kind: WallKind, signal: string): Wall => ({
    blocked: true,
    kind,
    status,
    signal,
    partial,
  });
  const marker = facts.markers[0] as WallKind | undefined;
  const textKind = wallTextKind(facts);
  if (marker)
    return verdict(
      marker,
      "page marker " + marker + (facts.title ? ' (title "' + facts.title.slice(0, 60) + '")' : ""),
    );
  if (
    textKind &&
    (textKind !== "waf" || (status !== null && status >= 400) || facts.textLength < 600)
  )
    return verdict(
      textKind,
      'title "' + facts.title.slice(0, 60) + '"' + (status ? " " + status : ""),
    );
  const vercel = partial.find((row) => row.kind === "vercel");
  if (vercel) return verdict("vercel", wallPath(vercel.url) + " " + vercel.status);
  const statusKind = wallStatusKind(status ?? undefined);
  if (statusKind) return verdict(statusKind, "document " + wallPath(facts.url) + " " + status);
  if (wallLogin(facts)) return verdict("login", "sign-in form at " + wallPath(facts.url));
  return {
    blocked: false,
    kind: null,
    status,
    signal: partial.length
      ? "partial: " + wallPath(partial[0]!.url) + " " + partial[0]!.status
      : null,
    partial,
  };
}

/** One line for logs, or "" for a healthy page. */
export function wallLine(wall: Wall): string {
  if (wall.blocked) return "blocked by " + wall.kind + " (" + wall.signal + ")";
  if (wall.partial.length)
    return (
      "partial wall: " +
      wall.partial.length +
      " data request" +
      (wall.partial.length === 1 ? "" : "s") +
      " refused (" +
      wall.signal +
      ")"
    );
  return "";
}
