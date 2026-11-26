import type { Operation, SiteModel } from "../types.js";
import { inputParams } from "../params.js";
import { createRedactor } from "../redact.js";
import { paramsType, pascal, propertyName, responseType, tsType } from "./client.js";

// A typed TypeScript client with no dependencies: one method per operation, plain fetch, the
// caller's own headers (cookies, tokens) passed in. Made from a capture, so it works offline from
// any project without the site-mapper runtime.

interface CallSpec {
  method: string;
  url: string;
  path: string[];
  query: string[];
  headers: string[];
  constants: Record<string, string>;
  body: "none" | "json" | "graphql";
  graphql?: { query?: string; operationName?: string; extensions?: unknown };
}

function callSpec(operation: Operation): CallSpec {
  const params = inputParams(operation);
  const redactor = createRedactor();
  const constants: Record<string, string> = {};
  for (const param of operation.params)
    if (param.in === "query" && param.constant !== undefined && !param.derived)
      constants[param.name] = redactor.text(param.constant);
  const graphql = operation.kind === "graphql" ? operation.graphql : undefined;
  return {
    method: operation.method,
    url: operation.origin + operation.path,
    path: params.filter((param) => param.in === "path").map((param) => param.name),
    query: params.filter((param) => param.in === "query").map((param) => param.name),
    headers: params.filter((param) => param.in === "header").map((param) => param.name),
    constants,
    body: graphql ? "graphql" : operation.requestBody ? "json" : "none",
    ...(graphql
      ? {
          graphql: {
            ...(graphql.query ? { query: graphql.query } : {}),
            ...(graphql.operationName ? { operationName: graphql.operationName } : {}),
            ...(graphql.extensions ? { extensions: graphql.extensions } : {}),
          },
        }
      : {}),
  };
}

const RUNTIME = `export interface ClientOptions {
  /** Replaces each operation's recorded origin, e.g. a local mock server. */
  baseUrl?: string;
  /** Sent with every call: cookies, authorization, CSRF tokens. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

interface CallSpec {
  method: string;
  url: string;
  path: string[];
  query: string[];
  headers: string[];
  constants: Record<string, string>;
  body: "none" | "json" | "graphql";
  graphql?: { query?: string; operationName?: string; extensions?: unknown };
}

async function send(options: ClientOptions, spec: CallSpec, params: Record<string, unknown> = {}): Promise<unknown> {
  const used = new Set<string>();
  let url = spec.url;
  for (const name of spec.path) {
    used.add(name);
    url = url.replace("{" + name + "}", encodeURIComponent(String(params[name] ?? "")));
  }
  const target = new URL(url);
  if (options.baseUrl) {
    const base = new URL(options.baseUrl);
    target.protocol = base.protocol;
    target.host = base.host;
  }
  for (const [name, value] of Object.entries(spec.constants)) target.searchParams.set(name, value);
  for (const name of spec.query) {
    used.add(name);
    if (params[name] !== undefined) target.searchParams.set(name, String(params[name]));
  }
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  for (const name of spec.headers) {
    used.add(name);
    if (params[name] !== undefined) headers[name] = String(params[name]);
  }
  let body: string | undefined;
  if (spec.body === "graphql") body = JSON.stringify({ ...spec.graphql, variables: params.variables ?? {} });
  else if (spec.body === "json") {
    const rest = Object.fromEntries(Object.entries(params).filter(([key]) => !used.has(key) && key !== "body"));
    body = JSON.stringify(params.body ?? rest);
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await (options.fetch ?? fetch)(target.href, { method: spec.method, headers, body });
  const text = await response.text();
  if (!response.ok) throw new Error(spec.method + " " + target.pathname + " failed with " + response.status + ": " + text.slice(0, 200));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
`;

/** The client's source: types, the call table and createClient(options). */
export function generateDirectClient(model: SiteModel): string {
  const typeName = pascal(model.site.replace(/\./g, " ")) + "Client";
  const out: string[] = [
    `// Typed client for ${model.site}, generated from a capture. No dependencies: it uses fetch.`,
    "",
    RUNTIME,
  ];
  for (const [name, schema] of Object.entries(model.components))
    out.push(`export type ${pascal(name)} = ${tsType(schema)};`, "");
  const specs: string[] = [];
  const methods: string[] = [];
  const impl: string[] = [];
  for (const operation of model.operations) {
    const base = pascal(operation.id);
    const optional = operation.params.some((p) => p.in === "path") ? "" : "?";
    out.push(
      `export type ${base}Params = ${paramsType(operation)};`,
      `export type ${base}Response = ${responseType(operation)};`,
      "",
    );
    specs.push(`  ${propertyName(operation.id)}: ${JSON.stringify(callSpec(operation))},`);
    methods.push(
      `  /** ${operation.method} ${operation.path} */`,
      `  ${propertyName(operation.id)}(params${optional}: ${base}Params): Promise<${base}Response>;`,
    );
    impl.push(
      `    ${propertyName(operation.id)}: (params) => send(options, SPECS[${JSON.stringify(operation.id)}], params as Record<string, unknown>) as Promise<${base}Response>,`,
    );
  }
  out.push(
    `const SPECS: Record<string, CallSpec> = {`,
    ...specs,
    `};`,
    "",
    `export interface ${typeName} {`,
    ...methods,
    `}`,
    "",
    `export function createClient(options: ClientOptions = {}): ${typeName} {`,
    `  return {`,
    ...impl,
    `  };`,
    `}`,
    "",
  );
  return out.join("\n");
}
