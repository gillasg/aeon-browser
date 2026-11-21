import type { Exchange } from "../types.js";
import { parseJson } from "./schema.js";

// Reading request bodies (JSON, forms, GraphQL, JSON-RPC) and telling operations apart.

export interface ParsedBody {
  mime: string;
  value?: unknown;
  form?: boolean;
}

export function requestMime(exchange: Exchange): string {
  return (exchange.requestHeaders["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function parseRequestBody(exchange: Exchange): ParsedBody | undefined {
  const raw = exchange.requestBody;
  if (raw === undefined || raw === "") return undefined;
  const mime = requestMime(exchange);
  // Some sites send JSON labelled as a form (it skips the CORS preflight): it is JSON, sent with
  // the same label.
  const labelledJson =
    mime.includes("x-www-form-urlencoded") && /^\s*[[{]/.test(raw) ? parseJson(raw) : undefined;
  if (labelledJson !== undefined) return { mime, value: labelledJson };
  if (mime.includes("x-www-form-urlencoded")) {
    const value: Record<string, unknown> = {};
    for (const [key, item] of new URLSearchParams(raw)) value[key] = parseJson(item) ?? item;
    return { mime, value, form: true };
  }
  const json = parseJson(raw);
  if (json !== undefined) return { mime: mime || "application/json", value: json };
  return { mime: mime || "text/plain" };
}

export function responseJson(exchange: Exchange): unknown {
  if (exchange.responseBase64) return undefined;
  return parseJson(exchange.responseBody);
}

export interface GraphqlCall {
  operationName?: string;
  hash?: string;
  query?: string;
  type: "query" | "mutation" | "subscription";
  /** The first root field, for an anonymous operation. */
  field?: string;
  extensions?: Record<string, unknown>;
  variables?: unknown;
  /** Where the variables live: the JSON body, or the `variables` query parameter for GET. */
  variablesPath: string;
}

function operationFromQuery(query: string | undefined): {
  name?: string;
  type: GraphqlCall["type"];
} {
  const match = /^\s*(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(query ?? "");
  const type = (match?.[1] as GraphqlCall["type"] | undefined) ?? "query";
  return match?.[2] ? { name: match[2], type } : { type };
}

/** The first field selected at the root of a query: `query { viewer { id } }` gives viewer. */
export function rootField(query: string | undefined): string | undefined {
  if (!query) return undefined;
  const text = query.replace(/#[^\n]*/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const start = /^\s*(?:(?:query|mutation|subscription)\b[^{(]*(?:\([^)]*\))?[^{]*)?\{/.exec(text);
  if (!start) return undefined;
  const rest = text.slice(start[0].length);
  const field = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  return field?.[1];
}

const fromJsonText = (value: unknown): unknown =>
  typeof value === "string" ? parseJson(value) : value;

/** Search APIs also send {"query": "words"}: only GraphQL text, or GraphQL's other fields, count. */
function graphqlText(source: Record<string, unknown>): string | undefined {
  const text = typeof source.query === "string" ? source.query : undefined;
  if (!text) return undefined;
  const looksGraphql =
    /^\s*(query|mutation|subscription|fragment)\b|^\s*\{/.test(text) ||
    typeof source.operationName === "string" ||
    source.variables !== undefined;
  return looksGraphql ? text : undefined;
}

function graphqlFrom(
  source: Record<string, unknown>,
  variablesPath: string,
): GraphqlCall | undefined {
  const extensions = recordOf(fromJsonText(source.extensions));
  const persisted = recordOf(extensions?.persistedQuery);
  const hash = typeof persisted?.sha256Hash === "string" ? persisted.sha256Hash : undefined;
  const query = graphqlText(source);
  if (!query && !hash) return undefined;
  const parsed = operationFromQuery(query);
  const named = typeof source.operationName === "string" ? source.operationName : "";
  const name = named || parsed.name;
  const field = name ? undefined : rootField(query);
  const variables = fromJsonText(source.variables);
  const call: GraphqlCall = { type: parsed.type, variablesPath };
  const extra = { operationName: name || undefined, field, hash, query, extensions, variables };
  for (const [key, value] of Object.entries(extra))
    if (value !== undefined) (call as unknown as Record<string, unknown>)[key] = value;
  return call;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function graphqlCall(
  exchange: Exchange,
  body: ParsedBody | undefined,
): GraphqlCall | undefined {
  const value = Array.isArray(body?.value) ? body?.value[0] : body?.value;
  if (value && typeof value === "object") {
    const call = graphqlFrom(value as Record<string, unknown>, "body:/variables");
    if (call) return call;
  }
  if (exchange.method !== "GET") return undefined;
  const params = Object.fromEntries(new URL(exchange.url).searchParams);
  return graphqlFrom(params, "query:variables");
}

export function rpcMethod(body: ParsedBody | undefined): string | undefined {
  const value = Array.isArray(body?.value) ? body?.value[0] : body?.value;
  const record = value as Record<string, unknown> | undefined;
  if (
    record &&
    typeof record === "object" &&
    "jsonrpc" in record &&
    typeof record.method === "string"
  )
    return record.method;
  return undefined;
}

export const ACTION_FIELDS = [
  "action",
  "op",
  "opname",
  "operation",
  "cmd",
  "command",
  "fn",
  "func",
];

/** A query or body field naming what the endpoint should do: `?action=addToCart`. */
export function actionField(
  exchange: Exchange,
  body: ParsedBody | undefined,
): { in: "query" | "body"; name: string; value: string } | undefined {
  const params = new URL(exchange.url).searchParams;
  for (const name of ACTION_FIELDS) {
    const value = params.get(name);
    if (value && /^[\w.:/-]{1,60}$/.test(value)) return { in: "query", name, value };
  }
  const record = body?.value as Record<string, unknown> | undefined;
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  for (const name of ACTION_FIELDS) {
    const value = record[name];
    if (typeof value === "string" && /^[\w.:/-]{1,60}$/.test(value))
      return { in: "body", name, value };
  }
  return undefined;
}
