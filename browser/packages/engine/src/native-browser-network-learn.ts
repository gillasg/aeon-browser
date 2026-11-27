import { toHar, type NetworkEntry } from "./native-browser-network-format.js";
import { classOfEntry, isApiLikeClass } from "./request-class.js";

export { isTrackerUrl } from "./request-class.js";

// What a recording hands over for learning a site's API after each step: the finished
// requests not handed over before, as HAR, without what must never be saved (cookies and the
// cookies a response sets, passwords and card numbers in bodies). Passive recordings forget
// what they hand over, so a long task doesn't pile up requests.

const SECRET_HEADERS = new Set(["cookie", "set-cookie"]);
const SECRET_FIELDS = /pass(word|wd)?|pwd|otp|one.?time|cvv|cvc|card.?number|security.?code|pin$/i;

/** Request headers whose value is a credential the site hands its own page. */
const SECRET_REQUEST_HEADER =
  /^(authorization|x-[\w-]*(token|csrf|xsrf|auth|key)[\w-]*|[\w-]*(csrf|xsrf)[\w-]*|api[-_]?key)$/i;
const META_TAG = /<meta\b[^>]*>/gi;
const MAX_PROVENANCE_SCAN = 200;

/** Where each secret header's value came from, by entry. Tags only, never values. */
const provenance = new WeakMap<NetworkEntry, Record<string, string>>();

export interface Taking {
  entries: Map<string, NetworkEntry>;
  passive?: boolean;
  taken?: Set<string>;
  bodyBytes: number;
}

/** A server-sent event stream that has delivered messages. */
function streamed(entry: NetworkEntry): boolean {
  return entry.type === "EventSource" && (entry.messages?.length ?? 0) > 0;
}

/** The finished requests since the last take, as HAR, with secrets removed. */
export function takeLearned(recorder: Taking): unknown {
  recorder.taken ??= new Set();
  const ready = [...recorder.entries.values()]
    .filter((entry) => !entry.requestBodyPending && !recorder.taken?.has(entry.id))
    .filter((entry) => entry.done || streamed(entry))
    // An EventSource the page closed may never report finishing: what it received is its record.
    .map((entry) => (entry.done ? entry : Object.assign(entry, { done: true })));
  // A site's API is its calls: not its documents, assets, media, challenges, sensors or beacons.
  const calls = ready.filter((entry) => isApiLikeClass(classOfEntry(entry)));
  for (const entry of calls) tagProvenance(recorder.entries, entry);
  // The HAR is built before a passive recording forgets bodies: a user tab learns from them too.
  const har = toHar(calls.map(withoutSecrets)) as { log: { entries: Record<string, unknown>[] } };
  calls
    .filter((entry) => entry.done || entry.type === "WebSocket")
    .forEach((entry, index) => {
      const tags = provenance.get(entry);
      const item = har.log.entries[index];
      // A list of {for, from}: keyed by header name, the sealer would treat each tag as a secret.
      if (tags && item)
        item._provenance = Object.entries(tags).map(([header, from]) => ({ for: header, from }));
    });
  for (const entry of ready) {
    if (recorder.passive && entry.body !== undefined) {
      recorder.bodyBytes -= entry.body.length;
      delete entry.body;
      entry.bodyDropped = true;
    }
    recorder.taken.add(entry.id);
  }
  return har;
}

function withoutSecrets(entry: NetworkEntry): NetworkEntry {
  const clean = (headers: Record<string, string> | undefined) =>
    headers &&
    Object.fromEntries(
      Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase())),
    );
  const requestHeaders = clean(entry.requestHeaders) ?? {};
  const responseHeaders = clean(entry.responseHeaders);
  return {
    ...entry,
    requestHeaders,
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(entry.requestBody !== undefined ? { requestBody: scrub(entry.requestBody) } : {}),
  };
}

/** Passwords and card details in a JSON or form body become "[removed]". */
function scrub(body: string): string {
  try {
    return JSON.stringify(scrubValue(JSON.parse(body) as unknown));
  } catch {
    // Only a urlencoded form is rewritten: a multipart body keeps its parts and line breaks.
    if (/content-disposition:/i.test(body)) return scrubMultipart(body);
    if (!/^[\w.%*~+-]*=[^\r\n]*$/.test(body)) return body;
    const form = new URLSearchParams(body);
    for (const key of [...form.keys()]) if (SECRET_FIELDS.test(key)) form.set(key, "[removed]");
    return form.toString();
  }
}

/** A multipart text part named like a password or card field keeps its name, not its value. */
function scrubMultipart(body: string): string {
  return body.replace(
    /(name="([^"]*)"\r?\n\r?\n)([^\r\n]*)/gi,
    (all, head: string, name: string) => (SECRET_FIELDS.test(name) ? `${head}[removed]` : all),
  );
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_FIELDS.test(key) && typeof item !== "object" ? "[removed]" : scrubValue(item),
    ]),
  );
}

/**
 * Tags each secret request header with where its raw value was found before anything is
 * sealed: a meta tag of the page, a cookie, or an earlier response (`response:<url>#<pointer>`).
 * The raw values are compared here and dropped; only the tag is kept.
 */
export function tagProvenance(entries: Map<string, NetworkEntry>, entry: NetworkEntry): void {
  const tags = provenance.get(entry) ?? {};
  for (const [name, raw] of Object.entries(entry.requestHeaders ?? {})) {
    const header = name.toLowerCase();
    if (tags[header] || !SECRET_REQUEST_HEADER.test(header)) continue;
    const value = raw.replace(/^(bearer|token)\s+/i, "").trim();
    if (value.length < 4) continue;
    const tag =
      cookieTag(entry.requestHeaders, value) ?? earlierTag(entries, entry, value) ?? undefined;
    if (tag) tags[header] = tag;
  }
  if (Object.keys(tags).length) provenance.set(entry, tags);
}

function cookieTag(headers: Record<string, string>, value: string): string | undefined {
  const cookie = Object.entries(headers).find(([name]) => name.toLowerCase() === "cookie")?.[1];
  for (const pair of (cookie ?? "").split(/;\s*/)) {
    const index = pair.indexOf("=");
    if (index > 0 && decode(pair.slice(index + 1)) === value)
      return `cookie:${pair.slice(0, index)}`;
  }
  return undefined;
}

/** The newest earlier page or response that carried the value. */
function earlierTag(
  entries: Map<string, NetworkEntry>,
  entry: NetworkEntry,
  value: string,
): string | undefined {
  const earlier = [...entries.values()]
    .filter((item) => item !== entry && item.startedAt <= entry.startedAt && item.body)
    .slice(-MAX_PROVENANCE_SCAN)
    .reverse();
  for (const item of earlier) {
    const body = item.body ?? "";
    if (!body.includes(value)) continue;
    if (item.type === "Document" || /html/i.test(item.mimeType ?? "")) {
      const meta = metaName(body, value);
      if (meta) return `meta:${meta}`;
      continue;
    }
    const pointer = pointerOf(body, value);
    if (pointer !== undefined) return `response:${item.url.split(/[?#]/)[0]}#${pointer}`;
  }
  return undefined;
}

function metaName(html: string, value: string): string | undefined {
  for (const tag of html.match(META_TAG) ?? []) {
    const content = /\bcontent\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1];
    if (content !== value) continue;
    const name = /\b(name|property)\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[2];
    if (name) return name;
  }
  return undefined;
}

/** The JSON pointer of the string leaf equal to the value, if the body is JSON. */
function pointerOf(body: string, value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  const walk = (node: unknown, pointer: string, depth: number): string | undefined => {
    if (typeof node === "string") return node === value ? pointer : undefined;
    if (!node || typeof node !== "object" || depth > 12) return undefined;
    for (const [key, child] of Object.entries(node)) {
      const found = walk(
        child,
        `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        depth + 1,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(parsed, "", 0);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
