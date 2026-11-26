// GraphQL traffic census and replay, pure. page.network.graphql() reads recorded requests through
// these; page.graphql.call() rebuilds one with fresh variables. Each function is embedded in the
// sandbox by source (code-api-posthoc-net.ts), so it must stay self-contained: no imports, and
// it may call only the other functions of this file by name.

export interface GqlEntry {
  id?: string;
  method?: string;
  url: string;
  status?: number;
  requestBody?: string;
}

export interface GqlOp {
  id?: string | undefined;
  op: string;
  kind: "query" | "mutation" | "persisted";
  hash?: string;
  url: string;
  method: string;
  variables: unknown;
  batchIndex?: number;
  status: number | null;
}

/** Keys that hold secrets are replaced, strings are bounded, depth is capped. */
export function gqlScrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) + "…" : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => gqlScrub(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 60))
    out[key] = /pass(word)?|secret|token|auth|session|cookie|api.?key|signature/i.test(key)
      ? "[redacted]"
      : gqlScrub(item, depth + 1);
  return out;
}

/** The operation name: operationName, the named operation, or the first root field. */
export function gqlOpName(item: Record<string, unknown>): string | undefined {
  if (typeof item.operationName === "string" && item.operationName) return item.operationName;
  const query = typeof item.query === "string" ? item.query : "";
  const named = /^\s*(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(query);
  if (named) return named[1];
  const brace = query.indexOf("{");
  if (brace < 0) return undefined;
  const root = /^\s*([A-Za-z_]\w*)\s*(:\s*([A-Za-z_]\w*))?/.exec(query.slice(brace + 1));
  return root ? root[3] || root[1] : undefined;
}

export function gqlHashOf(extensions: unknown): string | undefined {
  const persisted = extensions && (extensions as Record<string, unknown>).persistedQuery;
  const hash = persisted && (persisted as Record<string, unknown>).sha256Hash;
  return typeof hash === "string" ? hash : undefined;
}

export function gqlJson(text: unknown): unknown {
  if (typeof text !== "string" || !text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One body item ({operationName, query, variables, extensions}) as an operation, or nothing. */
export function gqlItemOf(item: unknown): Omit<GqlOp, "url" | "method" | "status"> | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const body = item as Record<string, unknown>;
  const hash = gqlHashOf(body.extensions);
  if (typeof body.query !== "string" && !hash) return undefined;
  const op = gqlOpName(body) || (hash ? hash.slice(0, 12) : undefined);
  if (!op) return undefined;
  const query = typeof body.query === "string" ? body.query : "";
  const kind = /^\s*mutation\b/.test(query) ? "mutation" : query ? "query" : "persisted";
  return {
    op,
    kind,
    ...(hash ? { hash } : {}),
    variables: gqlScrub(body.variables ?? {}),
  };
}

/** A persisted GET: ?operationName=&extensions= or Airbnb's /api/v3/<Op>/<sha256>. */
export function gqlFromUrl(url: string): Omit<GqlOp, "url" | "method" | "status"> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const params = parsed.searchParams;
  const variables = gqlJson(params.get("variables")) ?? {};
  const path = /\/api\/v\d+\/([A-Za-z_]\w*)\/([0-9a-f]{32,64})(?:\/|$)/.exec(parsed.pathname);
  if (path)
    return { op: path[1]!, kind: "persisted", hash: path[2]!, variables: gqlScrub(variables) };
  const fromParams = gqlItemOf({
    operationName: params.get("operationName") || undefined,
    query: params.get("query") || undefined,
    variables,
    extensions: gqlJson(params.get("extensions")),
  });
  return fromParams;
}

/** Every GraphQL operation in one recorded request (a batch gives one per item, with batchIndex). */
export function gqlOpsOf(entry: GqlEntry): GqlOp[] {
  const method = String(entry.method || "GET").toUpperCase();
  const base = { id: entry.id, url: entry.url, method, status: entry.status ?? null };
  if (method === "GET") {
    const op = gqlFromUrl(entry.url);
    return op ? [{ ...base, ...op }] : [];
  }
  const body = gqlJson(entry.requestBody);
  if (Array.isArray(body)) {
    const ops: GqlOp[] = [];
    body.slice(0, 50).forEach((item, batchIndex) => {
      const op = gqlItemOf(item);
      if (op) ops.push({ ...base, ...op, batchIndex });
    });
    return ops;
  }
  const op = gqlItemOf(body);
  return op ? [{ ...base, ...op }] : [];
}

/** The census over a recording, newest last, filtered by op name (string or /regex/). */
export function gqlCensus(entries: GqlEntry[], filter: { op?: unknown; limit?: number }): GqlOp[] {
  const wanted = filter.op;
  const matches = (name: string) =>
    !wanted ||
    (wanted instanceof RegExp
      ? wanted.test(name)
      : name.toLowerCase() === String(wanted).toLowerCase());
  const ops: GqlOp[] = [];
  for (const entry of entries) for (const op of gqlOpsOf(entry)) if (matches(op.op)) ops.push(op);
  return ops.slice(-Math.max(1, Math.min(Number(filter.limit) || 200, 500)));
}

/** The top-level keys of a response's data (each batch item's, for a batch). */
export function gqlResponseKeys(body: unknown, batchIndex?: number): string[] {
  const item = Array.isArray(body) ? body[batchIndex ?? 0] : body;
  const data =
    item && typeof item === "object" ? (item as Record<string, unknown>).data : undefined;
  return data && typeof data === "object" ? Object.keys(data).slice(0, 30) : [];
}

export function gqlMerge(old: unknown, variables: unknown, replace: boolean): unknown {
  if (replace || !old || typeof old !== "object" || Array.isArray(old)) return variables ?? old;
  return { ...(old as Record<string, unknown>), ...((variables as Record<string, unknown>) || {}) };
}

/**
 * The request that re-sends a recorded operation with new variables: the same URL, method, query
 * or persisted hash, and batch wrapper. {json} for a POST body, {url} with new query params for a GET.
 */
export function gqlBuildCall(
  recorded: { url: string; method?: string; requestBody?: string },
  op: { batchIndex?: number },
  variables: unknown,
  replace = false,
): { url: string; method: string; json?: unknown } {
  const method = String(recorded.method || "GET").toUpperCase();
  if (method === "GET") {
    const url = new URL(recorded.url);
    const old = gqlJson(url.searchParams.get("variables"));
    if (variables !== undefined || old !== undefined)
      url.searchParams.set("variables", JSON.stringify(gqlMerge(old, variables, replace)));
    return { url: url.href, method };
  }
  const body = gqlJson(recorded.requestBody);
  const batched = Array.isArray(body);
  const item = batched ? body[op.batchIndex ?? 0] : body;
  if (!item || typeof item !== "object") throw new Error("the recorded GraphQL body is not JSON");
  const record = item as Record<string, unknown>;
  const next = { ...record, variables: gqlMerge(record.variables, variables, replace) };
  return { url: recorded.url, method, json: batched ? [next] : next };
}

/** The data of a GraphQL answer (the first item of a batch), with its errors when there is no data. */
export function gqlDataOf(json: unknown): unknown {
  const item = Array.isArray(json) ? json[0] : json;
  if (!item || typeof item !== "object") return item;
  const answer = item as Record<string, unknown>;
  if (answer.data !== undefined && answer.data !== null) return answer.data;
  return answer.errors ? { errors: answer.errors } : answer;
}
