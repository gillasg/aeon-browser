import { randomUUID, randomBytes } from "node:crypto";
import { parseJson } from "../infer/schema.js";
import { declaredInputs, plainInputName } from "./bad-request.js";
import { isSessionSecretHeader } from "../session-headers.js";
import { isTelemetryHeader } from "../infer/operations.js";
import { isSealedValue, undoubled } from "../sealed.js";
import type { Dependency, Operation, Param } from "../types.js";

// Builds a concrete request from an operation and the caller's parameters. The last recorded
// request is the template (so defaults the site expects are kept); caller values, fresh
// generated values and resolved dependencies replace what changes.

export interface RuntimeRequest {
  operationId: string;
  origin: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Headers only the live page can fill (their recording was sealed): send through the page. */
  pageHeaders?: string[];
}

export interface RuntimeResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  text?: string;
  url?: string;
  /** How the call differed from what was asked, e.g. a direct retry after the page failed. */
  notes?: string[];
}

export type Params = Record<string, unknown>;

/** Values for targets like `query:cursor` or `body:/variables/after`, set by pagination and dependency resolution. */
export const SET = "$set";

export function generate(kind: NonNullable<Param["generated"]>): string {
  if (kind === "uuid") return randomUUID();
  if (kind === "timestamp-ms") return String(Date.now());
  if (kind === "timestamp-s") return String(Math.floor(Date.now() / 1000));
  return randomBytes(12).toString("base64url");
}

export class MissingParams extends Error {
  constructor(
    operation: Operation,
    public readonly missing: string[],
  ) {
    super(missingMessage(operation, missing));
    this.name = "MissingParams";
  }
}

/** Which inputs are missing, the ones the operation declares, and how to pass them. */
function missingMessage(operation: Operation, missing: string[]): string {
  const names = missing.map(plainInputName);
  const declared = declaredInputs(operation).join(", ") || "none";
  return `${operation.id} needs: ${missing.join(", ")}. Declared inputs: ${declared}. Next: pass ${names.join(", ")} as call("${operation.id}", { ${names.map((name) => `${name}: …`).join(", ")} }).`;
}

function setPointer(target: unknown, pointer: string, value: unknown): unknown {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => (part === "*" ? "0" : part.replace(/~1/g, "/").replace(/~0/g, "~")));
  if (!parts.length) return value;
  const root = (
    target && typeof target === "object" ? target : /^\d+$/.test(parts[0] ?? "") ? [] : {}
  ) as Record<string, unknown>;
  let current = root;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) current[part] = value;
    else {
      const next = current[part];
      current[part] =
        next && typeof next === "object" ? next : /^\d+$/.test(parts[index + 1] ?? "") ? [] : {};
      current = current[part] as Record<string, unknown>;
    }
  });
  return root;
}

function lastSampleBody(operation: Operation): unknown {
  const raw = operation.samples[operation.samples.length - 1]?.requestBody;
  if (raw === undefined) return undefined;
  if (operation.requestBody?.form) return Object.fromEntries(new URLSearchParams(raw));
  return parseJson(raw);
}

function generatedTargets(operation: Operation): Map<string, NonNullable<Param["generated"]>> {
  const map = new Map<string, NonNullable<Param["generated"]>>();
  const signed = new Set([
    ...(operation.signing?.headers ?? []).map((h) => `header:${h}`),
    ...(operation.signing?.query ?? []).map((q) => `query:${q}`),
  ]);
  for (const dep of operation.dependencies)
    if (dep.source.kind === "generated" && !signed.has(dep.target))
      map.set(dep.target, dep.source.generator);
  return map;
}

/**
 * The GraphQL envelope: the recorded document (query, operationName, persisted-query extensions)
 * and the caller's variables. Variables come from `variables`, or from top-level params named
 * like a declared variable; a variable that never changed across recordings is filled in.
 */
export function graphqlPayload(
  operation: Operation,
  params: Params,
  consumed: Set<string>,
): Record<string, unknown> {
  consumed.add("variables");
  return {
    ...graphqlEnvelope(operation),
    variables: graphqlVariables(operation, params, consumed),
  };
}

/** The recorded call with the template's document, so a newer query wins over an old sample. */
function graphqlEnvelope(operation: Operation): Record<string, unknown> {
  const sample = lastSampleBody(operation) ?? lastSampleQuery(operation);
  const record = Array.isArray(sample) ? (sample[0] as unknown) : sample;
  const base: Record<string, unknown> = isRecord(record) ? { ...record } : {};
  const template = operation.graphql;
  if (template?.query) base.query = template.query;
  if (template?.operationName) base.operationName = template.operationName;
  if (template?.extensions) base.extensions = template.extensions;
  else if (typeof base.extensions === "string") base.extensions = parseJson(base.extensions);
  return base;
}

function graphqlVariables(
  operation: Operation,
  params: Params,
  consumed: Set<string>,
): Record<string, unknown> {
  const declared = operation.graphql?.variables ?? [];
  const variables: Record<string, unknown> = {};
  for (const variable of declared)
    if (variable.constant !== undefined) variables[variable.name] = variable.constant;
  if (isRecord(params.variables)) Object.assign(variables, params.variables);
  for (const { name } of declared) {
    if (params[name] === undefined || consumed.has(name)) continue;
    variables[name] = params[name];
    consumed.add(name);
  }
  return variables;
}

/** GET GraphQL keeps its envelope in the query string. */
function lastSampleQuery(operation: Operation): Record<string, unknown> | undefined {
  const url = operation.samples[operation.samples.length - 1]?.url;
  if (!url || operation.graphql?.variablesPath !== "query:variables") return undefined;
  try {
    const params = Object.fromEntries(new URL(url).searchParams);
    return Object.keys(params).length ? params : undefined;
  } catch {
    return undefined;
  }
}

function graphqlBody(operation: Operation, params: Params, consumed: Set<string>): unknown {
  return graphqlPayload(operation, params, consumed);
}

/** Writes a GET GraphQL call's envelope into the URL, as the site's client does. */
function graphqlQuery(operation: Operation, url: URL, params: Params, consumed: Set<string>): void {
  const payload = graphqlPayload(operation, params, consumed);
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (key === "variables" && isRecord(value) && !Object.keys(value).length) continue;
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function rpcBody(operation: Operation, params: Params, consumed: Set<string>): unknown {
  // JSON-RPC keeps its envelope (jsonrpc, method, id) and takes only the caller's params.
  const base = lastSampleBody(operation);
  const record = isRecord(base) ? base : {};
  const nested = isRecord(params.params) ? params.params : {};
  consumed.add("params");
  return { ...record, params: nested };
}

function jsonBody(operation: Operation, params: Params, consumed: Set<string>): unknown {
  // Other bodies start empty: every field must be passed, never replayed from the recording.
  // The exception is a field that had the same value in every recorded body: the caller never
  // needed to say it, so it is filled in, and anything the caller passes still wins.
  let body: unknown = { ...operation.requestBody?.constants };
  if (params.body !== undefined) {
    consumed.add("body");
    body = isRecord(body) && isRecord(params.body) ? { ...body, ...params.body } : params.body;
  }
  if (!isRecord(body)) return body;
  // Top-level body fields can be passed directly: api.addToCart({ productId: 7 }).
  const top = Object.keys((operation.requestBody?.schema.properties as object | undefined) ?? {});
  for (const key of top)
    if (params[key] !== undefined && !consumed.has(key)) {
      body[key] = params[key];
      consumed.add(key);
    }
  return body;
}

function bodyFor(operation: Operation, params: Params, consumed: Set<string>): unknown {
  if (operation.kind === "graphql") return graphqlBody(operation, params, consumed);
  if (operation.match?.rpcMethod) return rpcBody(operation, params, consumed);
  return jsonBody(operation, params, consumed);
}

function serializeBody(operation: Operation, body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (operation.requestBody?.form)
    return new URLSearchParams(
      Object.entries(body as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ]),
    ).toString();
  return typeof body === "string" ? body : JSON.stringify(body);
}

type Resolved = { value?: string; missing?: boolean; page?: boolean };

interface Inputs {
  params: Params;
  sets: Params;
  generated: Map<string, NonNullable<Param["generated"]>>;
}

function givenValue(param: Param, inputs: Inputs): string | undefined {
  const target = `${param.in}:${param.name}`;
  const value = inputs.sets[target] ?? inputs.params[param.name];
  if (value !== undefined && value !== null) return String(value);
  const made = inputs.generated.get(target) ?? param.generated;
  return made ? generate(made) : undefined;
}

function paramValue(operation: Operation, param: Param, inputs: Inputs): Resolved {
  const given = givenValue(param, inputs);
  if (given !== undefined) return { value: given };
  const target = `${param.in}:${param.name}`;
  const source = operation.dependencies.find((dep) => dep.target === target)?.source;
  // Fresh values come from the producing operation (resolved by the caller) or the session.
  if (source && source.kind !== "generated") return { missing: source.kind === "response" };
  return fallbackValue(param);
}

/** What to send when nobody passed a value and nothing produces one. */
function fallbackValue(param: Param): Resolved {
  // Values that belong to the user's session (CSRF tokens, auth headers) are never replayed from a
  // recording: the transport reads them from the live tab, its cookies or the site's own calls.
  if (param.in === "header" && isSessionSecretHeader(param.name)) return {};
  if (param.in === "header") return headerFallback(param);
  if (param.constant !== undefined) return { value: param.constant };
  // A page number is semantic, not recorded: the first page is safe.
  if (param.in === "query" && /^(page|pageNum|pageNumber)$/i.test(param.name) && param.required)
    return { value: "1" };
  // No recorded values: a missing required parameter must be supplied by the caller.
  return { missing: Boolean(param.required) };
}

/**
 * A header is never the caller's to supply: the recorded value is replayed, and the page or
 * session fills what it owns. A sealed handle or a redacted value is never replayed: the page
 * sends the real one, so the call needs the page transport.
 */
function headerFallback(param: Param): Resolved {
  if (isTelemetryHeader(param.name)) return {};
  const recorded = param.constant ?? param.examples?.[0];
  if (recorded === undefined) return {};
  const value = undoubled(String(recorded));
  if (isSealedValue(value)) return { page: true };
  if (/^(<\w+>|\[session\])$/.test(value)) return {};
  return { value };
}

function isSigned(operation: Operation, param: Param): boolean {
  if (param.derived) return true;
  const signing = operation.signing;
  if (!signing) return false;
  if (param.in === "header") return signing.headers.includes(param.name);
  return param.in === "query" && signing.query.includes(param.name);
}

interface Parts {
  path: string;
  url: URL;
  headers: Record<string, string>;
  missing: string[];
  pageHeaders: string[];
}

function applyParams(operation: Operation, inputs: Inputs, consumed: Set<string>): Parts {
  const parts: Parts = {
    path: operation.path,
    url: new URL(operation.origin),
    headers: {},
    missing: [],
    pageHeaders: [],
  };
  for (const param of operation.params) {
    consumed.add(param.name);
    if (isSigned(operation, param)) continue;
    const { value, missing, page } = paramValue(operation, param, inputs);
    if (page) parts.pageHeaders.push(param.name);
    if (value === undefined) {
      if (missing) parts.missing.push(`${param.in}:${param.name}`);
    } else if (param.in === "path")
      parts.path = parts.path.replace(`{${param.name}}`, encodeURIComponent(value));
    else if (param.in === "query") parts.url.searchParams.set(param.name, value);
    else if (param.in === "header") parts.headers[param.name] = value;
  }
  const field = operation.match?.field;
  if (field?.in === "query") parts.url.searchParams.set(field.name, field.value);
  return parts;
}

function buildBody(operation: Operation, inputs: Inputs, consumed: Set<string>): unknown {
  const hasBody =
    operation.method !== "GET" &&
    (operation.requestBody || operation.samples.some((s) => s.requestBody !== undefined));
  let body = hasBody ? bodyFor(operation, inputs.params, consumed) : undefined;
  for (const [target, value] of Object.entries(inputs.sets))
    if (target.startsWith("body:")) body = setPointer(body, target.slice(5), value);
  for (const [target, kind] of inputs.generated)
    if (target.startsWith("body:") && !(target in inputs.sets))
      body = setPointer(body, target.slice(5), generate(kind));
  return body;
}

/** Leftover caller values become query parameters on GETs; `$set` query targets always do. */
function extraQuery(operation: Operation, url: URL, inputs: Inputs, consumed: Set<string>): void {
  if (operation.method === "GET")
    for (const [key, value] of Object.entries(inputs.params))
      if (!consumed.has(key) && value !== undefined) url.searchParams.set(key, String(value));
  for (const [target, value] of Object.entries(inputs.sets))
    if (target.startsWith("query:") && !url.searchParams.has(target.slice(6)))
      url.searchParams.set(target.slice(6), String(value));
}

function contentType(operation: Operation, headers: Record<string, string>): void {
  const mime = operation.requestBody?.mime;
  if (mime) headers["content-type"] = mime + (operation.requestBody?.form ? ";charset=UTF-8" : "");
}

/** Session-derived headers (a sealed CSRF token): only the live page fills them. */
function sessionHeaders(operation: Operation): string[] {
  return operation.params
    .filter((param) => param.in === "header" && param.derived === "session")
    .map((param) => param.name);
}

/** Builds the request; `missing` lists required inputs nobody supplied, for dependency resolution. */
export function buildRequest(
  operation: Operation,
  params: Params = {},
): { request: RuntimeRequest; missing: string[] } {
  const sets = (params[SET] ?? {}) as Params;
  const inputs: Inputs = { params, sets, generated: generatedTargets(operation) };
  const consumed = new Set<string>([SET]);
  const { path, url, headers, missing, pageHeaders } = applyParams(operation, inputs, consumed);
  const body = buildBody(operation, inputs, consumed);
  if (operation.kind === "graphql" && operation.method === "GET")
    graphqlQuery(operation, url, params, consumed);
  extraQuery(operation, url, inputs, consumed);
  url.pathname = path;
  contentType(operation, headers);
  // Next links from link-style pagination replace the whole URL.
  const href = typeof sets.$url === "string" ? sets.$url : url.href;
  const request: RuntimeRequest = {
    operationId: operation.id,
    origin: operation.origin,
    method: operation.method,
    url: href,
    headers,
  };
  const page = [...pageHeaders, ...sessionHeaders(operation)];
  if (page.length) request.pageHeaders = page;
  const serialized = serializeBody(operation, body);
  if (serialized !== undefined && operation.method !== "GET") request.body = serialized;
  return { request, missing: missing.filter((target) => !(target in sets)) };
}

/** The dependency that can supply a missing input, if it comes from another operation's response. */
export function dependencyFor(
  operation: Operation,
  target: string,
):
  | (Dependency & { source: { kind: "response"; operationId: string; pointer: string } })
  | undefined {
  const dep = operation.dependencies.find(
    (d) =>
      d.target === target && d.source.kind === "response" && d.source.operationId !== operation.id,
  );
  return dep as never;
}
