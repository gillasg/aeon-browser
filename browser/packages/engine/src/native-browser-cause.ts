// Action → effect causality, pure. page.cause(action) snapshots the recording, the stores and the
// stream frames around an action and diffs them through these. Each function is embedded in the
// sandbox by source (code-api-cause.ts), so it must stay self-contained: no imports, and it may
// call only the other functions of this file (and gqlOpsOf, embedded beside them) by name.

export interface CauseEntry {
  id?: string;
  method?: string;
  url: string;
  type?: string;
  status?: number;
  requestBody?: string;
  class?: string;
}

export interface CauseRequest {
  id?: string | undefined;
  kind: "api" | "graphql";
  method: string;
  url: string;
  op?: string;
  diff?: Record<string, Record<string, [unknown, unknown]>>;
  status: number | null;
}

export type CauseNoise = Record<
  "tracker" | "media" | "challenge" | "asset" | "beacon" | "sensor" | "document",
  number
>;

/** The entry's class: the recorder's own when present, else a compact inline guess. */
export function causeClass(entry: CauseEntry): string {
  if (entry && typeof entry.class === "string" && entry.class) return entry.class;
  const url = String((entry && entry.url) || "");
  const type = String((entry && entry.type) || "").toLowerCase();
  const lower = url.toLowerCase();
  if (/\/graphql\b|\/gql\b|[?&]operationname=/.test(lower)) return "graphql";
  if (
    /challenge|captcha|turnstile|cdn-cgi\/|px-cloud|perimeterx|datadome|recaptcha|hcaptcha/.test(
      lower,
    )
  )
    return "challenge";
  if (/sensor|akam\/|_bm\/|fingerprint/.test(lower)) return "sensor";
  if (
    /google-analytics|googletagmanager|doubleclick|segment\.(io|com)|mixpanel|amplitude|hotjar|facebook\.com\/tr|clarity\.ms|sentry|datadoghq|newrelic|\/collect\b|\/track\b|\/analytics\b|\/pixel\b|\/events?\b/.test(
      lower,
    )
  )
    return "tracker";
  if (type === "ping" || /\/beacon\b|\/log\b|\/rum\b|\/telemetry\b/.test(lower)) return "beacon";
  if (
    type === "media" ||
    type === "image" ||
    /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|m3u8|mp3|ico)(\?|$)/.test(lower)
  )
    return "media";
  if (type === "document") return "document";
  if (
    type === "script" ||
    type === "stylesheet" ||
    type === "font" ||
    /\.(js|mjs|css|woff2?|ttf|map)(\?|$)/.test(lower)
  )
    return "asset";
  if (type === "websocket" || type === "eventsource") return "asset";
  return "api";
}

/** method + origin + path, with numeric and long-hex segments folded. */
export function causeKey(entry: CauseEntry): string {
  let path = String(entry.url || "");
  try {
    const parsed = new URL(path);
    path = parsed.origin + parsed.pathname;
  } catch {
    path = path.split("?")[0] || path;
  }
  path = path.replace(/\/(\d+|[0-9a-f]{16,})(?=\/|$)/gi, "/:id");
  return String(entry.method || "GET").toUpperCase() + " " + path;
}

export function causeQuery(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    new URL(url).searchParams.forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    /* not a URL */
  }
  return out;
}

export function causeBody(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string" || !text) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Secret keys are redacted, long strings cut, objects shown compact. */
export function causeValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (/pass(word)?|secret|token|auth|session|cookie|api.?key|signature|csrf/i.test(key))
    return "[redacted]";
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
  if (value && typeof value === "object") {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      return "[object]";
    }
    return text.length > 200 ? text.slice(0, 200) + "…" : value;
  }
  return value;
}

/** Changed, added and removed keys between two flat records: {key: [before, after]}. */
export function causeDiffKeys(before: unknown, after: unknown): Record<string, [unknown, unknown]> {
  const a = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const b = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].slice(0, 60)) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    out[key] = [causeValue(key, a[key]), causeValue(key, b[key])];
  }
  return out;
}

/** The GraphQL operation of an entry: from the census rows when given, else parsed here. */
export function causeGqlOf(
  entry: CauseEntry,
  ops: Array<{ id?: string; op: string; variables: unknown }> | undefined,
): { op: string; variables: unknown } | undefined {
  const fromCensus = (ops || []).find((op) => op && op.id !== undefined && op.id === entry.id);
  if (fromCensus) return fromCensus;
  const parse = (globalThis as Record<string, unknown>).gqlOpsOf;
  const local =
    typeof parse === "function"
      ? (parse as (e: CauseEntry) => Array<{ op: string; variables: unknown }>)(entry)
      : undefined;
  if (local && local[0]) return local[0];
  const body = causeBody(entry.requestBody);
  if (body && typeof body.operationName === "string")
    return { op: body.operationName, variables: body.variables };
  const query = causeQuery(entry.url);
  if (query.operationName) {
    let variables: unknown;
    try {
      variables = query.variables ? JSON.parse(query.variables) : undefined;
    } catch {
      variables = undefined;
    }
    return { op: query.operationName, variables };
  }
  return undefined;
}

/**
 * New api and GraphQL requests of the action window, each diffed against the latest earlier one
 * of the same endpoint (or GraphQL op). Everything else is counted in noise.
 */
export function causeDiffRequests(
  beforeEntries: CauseEntry[],
  afterEntries: CauseEntry[],
  gqlOpsBefore?: Array<{ id?: string; op: string; variables: unknown }>,
  gqlOpsAfter?: Array<{ id?: string; op: string; variables: unknown }>,
): { requests: CauseRequest[]; noise: CauseNoise } {
  const before = Array.isArray(beforeEntries) ? beforeEntries : [];
  const after = Array.isArray(afterEntries) ? afterEntries : [];
  const seen = new Set(before.map((entry) => entry && entry.id).filter((id) => id !== undefined));
  const fresh = after.filter((entry) =>
    entry && entry.id !== undefined ? !seen.has(entry.id) : !before.includes(entry),
  );
  const noise: CauseNoise = {
    tracker: 0,
    media: 0,
    challenge: 0,
    asset: 0,
    beacon: 0,
    sensor: 0,
    document: 0,
  };
  const history: CauseEntry[] = before.slice();
  const requests: CauseRequest[] = [];
  for (const entry of fresh) {
    if (!entry || !entry.url) continue;
    const cls = causeClass(entry);
    const gql = cls === "graphql" || cls === "api" ? causeGqlOf(entry, gqlOpsAfter) : undefined;
    if (!gql && cls !== "api") {
      if (cls in noise) noise[cls as keyof CauseNoise] += 1;
      history.push(entry);
      continue;
    }
    const kind: "api" | "graphql" = gql ? "graphql" : "api";
    const key = causeKey(entry);
    let prior: CauseEntry | undefined;
    let priorGql: { op: string; variables: unknown } | undefined;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const candidate = history[index];
      if (!candidate || !candidate.url) continue;
      if (gql) {
        const other = causeGqlOf(candidate, (gqlOpsBefore || []).concat(gqlOpsAfter || []));
        if (other && other.op === gql.op) {
          prior = candidate;
          priorGql = other;
          break;
        }
      } else if (causeKey(candidate) === key) {
        prior = candidate;
        break;
      }
    }
    const diff: Record<string, Record<string, [unknown, unknown]>> = {};
    if (prior) {
      const query = causeDiffKeys(causeQuery(prior.url), causeQuery(entry.url));
      if (gql) {
        delete query.variables;
        delete query.extensions;
      }
      if (Object.keys(query).length) diff.query = query;
      if (gql) {
        const variables = causeDiffKeys(priorGql && priorGql.variables, gql.variables);
        if (Object.keys(variables).length) diff.variables = variables;
      } else {
        const body = causeDiffKeys(causeBody(prior.requestBody), causeBody(entry.requestBody));
        if (Object.keys(body).length) diff.body = body;
      }
    }
    requests.push({
      id: entry.id,
      kind,
      method: String(entry.method || "GET").toUpperCase(),
      url: entry.url.length > 300 ? entry.url.slice(0, 300) + "…" : entry.url,
      ...(gql ? { op: gql.op } : {}),
      ...(Object.keys(diff).length ? { diff } : {}),
      status: typeof entry.status === "number" ? entry.status : null,
    });
    history.push(entry);
    if (requests.length >= 40) break;
  }
  return { requests, noise };
}

/** Top-level key changes across two page.state.stores() results, bounded. */
export function causeDiffStores(
  beforeStores: unknown,
  afterStores: unknown,
): Array<{ kind: string; path: string; before: unknown; after: unknown }> {
  const list = (value: unknown): Array<Record<string, unknown>> => {
    const rows = Array.isArray(value)
      ? value
      : value && Array.isArray((value as Record<string, unknown>).stores)
        ? ((value as Record<string, unknown>).stores as unknown[])
        : [];
    return rows.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
  };
  const name = (row: Record<string, unknown>) =>
    String(row.kind || "store") + ":" + String(row.source || "");
  const prior = new Map(list(beforeStores).map((row) => [name(row), row]));
  const out: Array<{ kind: string; path: string; before: unknown; after: unknown }> = [];
  for (const row of list(afterStores)) {
    const old = prior.get(name(row));
    const a = old ? old.data : undefined;
    const b = row.data;
    const isObj = (value: unknown) => value && typeof value === "object" && !Array.isArray(value);
    if (!isObj(a) || !isObj(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b))
        out.push({
          kind: String(row.kind || "store"),
          path: String(row.source || ""),
          before: causeValue("", a),
          after: causeValue("", b),
        });
      continue;
    }
    for (const [key, pair] of Object.entries(causeDiffKeys(a, b))) {
      out.push({
        kind: String(row.kind || "store"),
        path: (row.source ? String(row.source) + "." : "") + key,
        before: pair[0],
        after: pair[1],
      });
      if (out.length >= 30) return out;
    }
  }
  return out;
}

/** Frames that arrived in the window; accepts an array or {frames}. */
export function causeSliceFrames(
  beforeFrames: unknown,
  afterFrames: unknown,
): Array<{ stream: unknown; direction: unknown; sample: string }> {
  const list = (value: unknown): Array<Record<string, unknown>> => {
    const rows = Array.isArray(value)
      ? value
      : value && Array.isArray((value as Record<string, unknown>).frames)
        ? ((value as Record<string, unknown>).frames as unknown[])
        : [];
    return rows.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
  };
  const tag = (row: Record<string, unknown>) =>
    row.seq !== undefined
      ? "s" + String(row.seq)
      : JSON.stringify([row.url, row.at, row.time, row.data]);
  const seen = new Set(list(beforeFrames).map(tag));
  return list(afterFrames)
    .filter((row) => !seen.has(tag(row)))
    .slice(-30)
    .map((row) => {
      const raw =
        row.data !== undefined ? row.data : row.text !== undefined ? row.text : row.payload;
      let sample = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "");
      if (sample.length > 200) sample = sample.slice(0, 200) + "…";
      return {
        stream:
          row.stream !== undefined ? row.stream : row.url !== undefined ? row.url : row.requestId,
        direction: row.direction !== undefined ? row.direction : row.sent ? "sent" : "received",
        sample,
      };
    });
}
