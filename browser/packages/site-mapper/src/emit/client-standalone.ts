import type { Operation, SiteModel } from "../types.js";
import { itemsSchema } from "../runtime/model-helpers.js";
import { pascal, paramsType, propertyName, responseType, tsType } from "./client.js";

// A zero-dependency typed client for one mapped site. It imports nothing: its transport is plain
// fetch against the local REST server (`graft rest`, 127.0.0.1 only) with a per-client bearer
// token, paginated operations are async iterators, and a write the page has not yet proven
// throws NOT_PROVEN instead of going out.

export interface StandaloneClient {
  /** The client: `<site>.ts`. */
  source: string;
  /** Its declarations alone: `<site>.d.ts`. */
  declarations: string;
  /** The first read operation, for the one runnable next line. */
  firstRead?: string;
}

/** A write is proven once a recording saw it succeed from the page itself. */
export function provenWrite(operation: Operation): boolean {
  if (operation.role === "read") return true;
  return operation.samples.some((sample) => sample.status >= 200 && sample.status < 300);
}

function isWrite(operation: Operation): boolean {
  return (
    operation.role !== "read" || (operation.effect !== undefined && operation.effect !== "read")
  );
}

function declarations(model: SiteModel, typeName: string): string[] {
  const out: string[] = [];
  for (const [name, schema] of Object.entries(model.components))
    out.push(`export type ${pascal(name)} = ${tsType(schema)};`, "");
  const methods: string[] = [];
  const pagers: string[] = [];
  for (const operation of model.operations) {
    const base = pascal(operation.id);
    out.push(
      `export type ${base}Params = ${paramsType(operation)};`,
      `export type ${base}Response = ${responseType(operation)};`,
      "",
    );
    const optional = operation.params.some((p) => p.in === "path") ? "" : "?";
    const guard = isWrite(operation) && !provenWrite(operation) ? " Throws NOT_PROVEN." : "";
    methods.push(
      `  /** ${operation.method} ${operation.path} (${isWrite(operation) ? "write" : "read"}).${guard} */`,
      `  ${propertyName(operation.id)}(params${optional}: ${base}Params): Promise<${base}Response>;`,
    );
    if (operation.pagination) {
      const item = itemsSchema(model, operation);
      pagers.push(
        `    ${propertyName(operation.id)}(params${optional}: ${base}Params): AsyncIterable<${item ? tsType(item, 2) : "unknown"}>;`,
      );
    }
  }
  out.push(
    `export interface ${typeName} {`,
    ...methods,
    `  paginate: {`,
    ...pagers,
    `  };`,
    `}`,
    "",
    `export interface ${typeName}Options {`,
    `  /** Default http://127.0.0.1:4791 (graft rest). */`,
    `  baseUrl?: string;`,
    `  /** A token from \`graft mcp token create\`; default process.env.GRAFT_TOKEN. */`,
    `  token?: string;`,
    `}`,
    "",
  );
  return out;
}

const RUNTIME = String.raw`
type Json = Record<string, unknown>;
interface Paging { style: string; param?: string; nextPointer?: string; hasMorePointer?: string; itemsPointer?: string }

function pointer(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let at: unknown = value;
  for (const raw of path.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Json)[key];
  }
  return at;
}

function setParam(params: Json, target: string, value: unknown): Json {
  const next: Json = { ...params };
  const [where, name = ""] = target.includes(":") ? [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)] : ["query", target];
  if (where !== "body" || !name.startsWith("/")) {
    next[name] = value;
    return next;
  }
  const keys = name.split("/").slice(1);
  const root: Json = { ...((next.body as Json | undefined) ?? {}) };
  let at = root;
  for (const key of keys.slice(0, -1)) at = at[key] = { ...((at[key] as Json | undefined) ?? {}) };
  at[keys[keys.length - 1] ?? ""] = value;
  if (keys[0] === "variables" && keys.length === 2) next.variables = root.variables;
  else next.body = root;
  return next;
}

function firstArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object")
    for (const item of Object.values(value as Json)) if (Array.isArray(item)) return item;
  return [];
}
`;

function runtimeFor(model: SiteModel, typeName: string): string[] {
  const writes = model.operations
    .filter((op) => isWrite(op) && !provenWrite(op))
    .map((op) => op.id);
  const paging: Record<string, unknown> = {};
  for (const op of model.operations) if (op.pagination) paging[op.id] = op.pagination;
  const ids = [...model.operations.map((op) => op.id), ...model.pages.map((page) => page.id)];
  return [
    RUNTIME,
    `const SITE = ${JSON.stringify(model.site)};`,
    `const OPERATIONS: readonly string[] = ${JSON.stringify(ids)};`,
    `const NOT_PROVEN: ReadonlySet<string> = new Set(${JSON.stringify(writes)});`,
    `const PAGING: Record<string, Paging> = ${JSON.stringify(paging)};`,
    "",
    `export function create${typeName}(options: ${typeName}Options = {}): ${typeName} {`,
    `  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};`,
    `  const baseUrl = (options.baseUrl ?? env.GRAFT_REST_URL ?? "http://127.0.0.1:4791").replace(/\\/$/, "");`,
    `  const token = options.token ?? env.GRAFT_TOKEN ?? "";`,
    `  async function call(id: string, params: Json = {}): Promise<unknown> {`,
    `    if (NOT_PROVEN.has(id)) throw new Error("NOT_PROVEN: do it once in the page, then rebuild (" + id + ")");`,
    `    const response = await fetch(baseUrl + "/sites/" + encodeURIComponent(SITE) + "/ops/" + encodeURIComponent(id), {`,
    `      method: "POST",`,
    `      headers: { "content-type": "application/json", authorization: "Bearer " + token },`,
    `      body: JSON.stringify(params),`,
    `    });`,
    `    const text = await response.text();`,
    `    const body: unknown = text ? JSON.parse(text) : undefined;`,
    `    if (!response.ok) throw new Error(String((body as Json | undefined)?.error ?? response.status));`,
    `    return body;`,
    `  }`,
    `  async function* pages(id: string, params: Json = {}): AsyncGenerator<unknown> {`,
    `    const paging = PAGING[id];`,
    `    let current = params;`,
    `    for (let page = 0; page < 1000; page++) {`,
    `      const body = await call(id, current);`,
    `      const items = paging?.itemsPointer ? firstArray(pointer(body, paging.itemsPointer)) : firstArray(body);`,
    `      yield* items;`,
    `      if (!paging?.param || !items.length) return;`,
    `      if (paging.hasMorePointer && pointer(body, paging.hasMorePointer) === false) return;`,
    `      let next: unknown;`,
    `      if (paging.style === "cursor" || paging.style === "link") next = pointer(body, paging.nextPointer);`,
    `      else if (paging.style === "offset") next = Number(current[paging.param.split(":").pop() ?? ""] ?? 0) + items.length;`,
    `      else next = Number(current[paging.param.split(":").pop() ?? ""] ?? 1) + 1;`,
    `      if (next === undefined || next === null || next === "") return;`,
    `      current = setParam(current, paging.param, next);`,
    `    }`,
    `  }`,
    `  const client: Json = { paginate: {} };`,
    `  for (const id of OPERATIONS) client[id] = (params?: Json) => call(id, params);`,
    `  for (const id of Object.keys(PAGING)) (client.paginate as Json)[id] = (params?: Json) => pages(id, params);`,
    `  return client as unknown as ${typeName};`,
    `}`,
    "",
  ];
}

export function generateStandaloneClient(model: SiteModel): StandaloneClient {
  const typeName = pascal(model.site.replace(/\./g, " ")) + "Api";
  const header = [
    `// Typed client for ${model.site}. Zero dependencies: it calls the local REST server`,
    `// (graft rest) with a token from \`graft mcp token create\`. Regenerate with graft compile.`,
    "",
  ];
  const types = declarations(model, typeName);
  const firstRead = model.operations.find((op) => !isWrite(op))?.id;
  return {
    source: [...header, ...types, ...runtimeFor(model, typeName)].join("\n"),
    declarations: [
      ...header,
      ...types,
      `export declare function create${typeName}(options?: ${typeName}Options): ${typeName};`,
      "",
    ].join("\n"),
    ...(firstRead ? { firstRead } : {}),
  };
}

/** One operation's declaration: its params and response types and the method signature. */
export function operationDeclaration(model: SiteModel, id: string): string | undefined {
  const operation = model.operations.find((op) => op.id === id);
  if (!operation) return undefined;
  const base = pascal(operation.id);
  const optional = operation.params.some((p) => p.in === "path") ? "" : "?";
  const guard = isWrite(operation) && !provenWrite(operation) ? " Throws NOT_PROVEN." : "";
  const lines = [
    `export type ${base}Params = ${paramsType(operation)};`,
    `export type ${base}Response = ${responseType(operation)};`,
    `/** ${operation.method} ${operation.path}.${guard} */`,
    `declare function ${operation.id}(params${optional}: ${base}Params): Promise<${base}Response>;`,
  ];
  if (operation.pagination) {
    const item = itemsSchema(model, operation);
    lines.push(
      `declare function paginate_${operation.id}(params${optional}: ${base}Params): AsyncIterable<${item ? tsType(item, 1) : "unknown"}>;`,
    );
  }
  return lines.join("\n");
}
