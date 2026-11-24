// Turns a raw step result into its committed form. It scrubs only what cannot match between two
// runs: the port-bearing origins, file roots, times, byte counts, request ids and multipart
// boundaries. Snapshot text, refs, URLs, statuses, bodies, console entries and error messages
// stay exact, so any real change in behaviour shows up as a diff against the golden transcript.

const TIME_KEYS = new Set([
  "ms",
  "elapsedMs",
  "durationMs",
  "tStart",
  "tEnd",
  "timestamp",
  "time",
  "startedAt",
  "at",
]);
const BYTE_KEYS = new Set(["bytes", "size", "encodedDataLength", "contentLength", "length"]);
const ID_KEYS = new Set(["id", "requestId", "exchangeId", "networkId"]);

/**
 * @param {unknown} value the raw result
 * @param {{primary: string, cross: string, files?: string[]}} context the run's volatile roots
 */
export function normalize(value, context) {
  const ids = new Map();
  const walk = (item, key) => {
    if (typeof item === "string") return scrubString(item, context);
    if (typeof item === "number") return scrubNumber(item, key, ids);
    if (Array.isArray(item)) return item.map((entry) => walk(entry, key));
    if (item && typeof item === "object") {
      const out = {};
      for (const name of Object.keys(item).sort()) out[name] = walk(item[name], name);
      return out;
    }
    return item;
  };
  return walk(value, undefined);
}

function scrubNumber(number, key, ids) {
  if (key === undefined) return number;
  if (TIME_KEYS.has(key)) return "<TIME>";
  if (BYTE_KEYS.has(key)) {
    if (!(number > 0)) throw new Error(`byte count "${key}" is ${number}, expected more than 0`);
    return "<BYTES>";
  }
  if (ID_KEYS.has(key)) return renumber(ids, number);
  return number;
}

function renumber(ids, raw) {
  if (!ids.has(raw)) ids.set(raw, `#${ids.size + 1}`);
  return ids.get(raw);
}

/** Origins become PRIMARY / CROSS, file roots <FILES>, durations <TIME>, boundaries vanish. */
export function scrubString(text, context) {
  let out = text;
  for (const root of context.files ?? []) if (root) out = out.split(root).join("<FILES>");
  out = out.split(context.primary).join("PRIMARY").split(context.cross).join("CROSS");
  const port = context.primary.split(":").pop();
  out = out.split(`127.0.0.1:${port}`).join("PRIMARY").split(`localhost:${port}`).join("CROSS");
  // Chrome's tab ids differ every run; the rest of the message stays exact.
  out = out.replace(/\btab \d+\b/g, "tab <TAB>");
  out = out.replace(/\b\d+(\.\d+)?\s?ms\b/g, "<TIME>");
  out = out.replace(/\b\d+(\.\d+)?\s?s\b(?=[^a-z]|$)/g, "<TIME>");
  out = out.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<TIME>");
  out = out.replace(/-{2,}[-\w]*[Bb]oundary[\w-]*/g, "<BOUNDARY>");
  out = out.replace(/boundary=[\w-]+/g, "boundary=<BOUNDARY>");
  return out;
}

/** A decoded image becomes its type, size and the colours at the probe points. */
export function imageRecord(image, probes) {
  return {
    type: image.type,
    size: [image.width, image.height],
    probes: probes.map(([x, y]) => ({ at: [x, y], rgb: image.pixel(x, y) })),
  };
}

/** Leaf-by-leaf difference between two normalized values, as JSON pointers. */
export function diffValues(expected, actual, pointer = "") {
  if (Object.is(expected, actual)) return [];
  const bothObjects =
    expected &&
    actual &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) return [{ pointer, expected, actual }];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const out = [];
  for (const key of [...keys].sort()) {
    const next = `${pointer}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (!(key in expected)) out.push({ pointer: next, expected: undefined, actual: actual[key] });
    else if (!(key in actual))
      out.push({ pointer: next, expected: expected[key], actual: undefined });
    else out.push(...diffValues(expected[key], actual[key], next));
  }
  return out;
}
