// A short page, or a 429, is the site saying stop. A known throttle interstitial (Amazon rush
// hour, Flipkart's traffic page) is the same thing even when the status is a 503.

// A bare 429 is a price, an order id or a count; only a status-shaped 429 is the site saying stop.
const STATUS_429 = String.raw`(?:\b(?:error|status|http(?:\/[\d.]+)?|code)\s*[:#]?\s*429\b|\b429\s*[-:–—]?\s*(?:too many|rate)|(?:^|\s)429(?:\s*[:—-]|$))`;
const GENERIC = new RegExp(
  String.raw`too many (?:attempts|requests)|try again later|rate limit|slow down|` + STATUS_429,
  "i",
);
const RUSH = /it['’]?s rush hour/i;
const TRAFFIC = /traffic is piling up/i;
const CROWD =
  /we(?:'re| are) (?:experiencing|facing|seeing) (?:heavy|high|a lot of) traffic|heavy traffic on (?:our|the) (?:site|page|servers)/i;
const SHORT = 800;
const INTERSTITIAL = 4000;

const RATE_LIMIT_TEXT =
  "RATE_LIMITED: this page is a throttle interstitial, not the site.\nHint: retry after a pause and open fewer tabs in parallel.";

/** Page-side copy of the detector, evaluated in the sandbox with page.read. */
export const THROTTLE_PAGE_JS = `
function __throttlePage(title, text) {
  title = String(title || "");
  text = String(text || "");
  var head = title + " " + text.slice(0, 500);
  var rush = text.length < 4000 && /it['’]?s rush hour/i.test(text) && (/traffic is piling up/i.test(text) || /503|service unavailable/i.test(title));
  var crowd = text.length < 4000 && /we(?:'re| are) (?:experiencing|facing|seeing) (?:heavy|high|a lot of) traffic|heavy traffic on (?:our|the) (?:site|page|servers)/i.test(text);
  var generic = text.length <= 800 && new RegExp(${JSON.stringify(GENERIC.source)}, "i").test(head);
  if (!rush && !crowd && !generic) return "";
  return "RATE_LIMITED: this page is a throttle interstitial, not the site.\\nHint: retry after a pause and open fewer tabs in parallel.";
}
`;

export function rateLimitError(text: string, status?: number, title = ""): string | undefined {
  if (status === 429) return RATE_LIMIT_TEXT;
  if (amazonRush(title, text) || crowdPage(text)) return RATE_LIMIT_TEXT;
  if (text.length > SHORT) return undefined;
  return GENERIC.test(`${title}\n${text}`) ? RATE_LIMIT_TEXT : undefined;
}

export function rateLimited(text: string, status?: number, title = ""): boolean {
  return rateLimitError(text, status, title) !== undefined;
}

export function rateLimitWarning(text: string, status?: number, title = ""): string | undefined {
  if (!rateLimited(text, status, title)) return undefined;
  return "[warn] RATE_LIMITED: throttle interstitial, not the site. Retry after a pause and open fewer tabs in parallel.";
}

function amazonRush(title: string, body: string): boolean {
  if (body.length >= INTERSTITIAL) return false;
  if (!RUSH.test(body)) return false;
  return TRAFFIC.test(body) || /503|service unavailable/i.test(title);
}

function crowdPage(body: string): boolean {
  return body.length < INTERSTITIAL && CROWD.test(body);
}
