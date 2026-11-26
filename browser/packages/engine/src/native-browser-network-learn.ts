import { toHar, type NetworkEntry } from "./native-browser-network-format.js";
import { classOfEntry, isApiLikeClass } from "./request-class.js";

export { isTrackerUrl } from "./request-class.js";

// What a recording hands over for learning a site's API after each step: the finished
// requests not handed over before, as HAR, without what must never be saved (cookies and the
// cookies a response sets, passwords and card numbers in bodies). Passive recordings forget
// what they hand over, so a long task doesn't pile up requests.

const SECRET_HEADERS = new Set(["cookie", "set-cookie"]);
const SECRET_FIELDS = /pass(word|wd)?|pwd|otp|one.?time|cvv|cvc|card.?number|security.?code|pin$/i;

interface Taking {
  entries: Map<string, NetworkEntry>;
  passive?: boolean;
  taken?: Set<string>;
  bodyBytes: number;
}

/** The finished requests since the last take, as HAR, with secrets removed. */
export function takeLearned(recorder: Taking): unknown {
  recorder.taken ??= new Set();
  const ready = [...recorder.entries.values()].filter(
    (entry) => entry.done && !entry.requestBodyPending && !recorder.taken?.has(entry.id),
  );
  // A site's API is its calls: not its documents, assets, media, challenges, sensors or beacons.
  const calls = ready.filter((entry) => isApiLikeClass(classOfEntry(entry)));
  for (const entry of ready) {
    if (recorder.passive && entry.body !== undefined) {
      recorder.bodyBytes -= entry.body.length;
      delete entry.body;
      entry.bodyDropped = true;
    }
    recorder.taken.add(entry.id);
  }
  return toHar(calls.map(withoutSecrets));
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
    if (!body.includes("=")) return body;
    const form = new URLSearchParams(body);
    for (const key of [...form.keys()]) if (SECRET_FIELDS.test(key)) form.set(key, "[removed]");
    return form.toString();
  }
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
