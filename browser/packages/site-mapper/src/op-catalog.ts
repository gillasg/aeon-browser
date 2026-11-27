// What an agent sees of an operation: a plain description of what it does, only the inputs it
// can pass (no headers, cookies, plumbing or minted values), which inputs have a default, and
// where an id comes from. One place, so MCP tools, the operations listing and the shared
// site_mapper tool say the same thing. Host and method stay in annotations, not in the text.

import { isDerived } from "./params.js";
import type { JsonSchema, Operation, Param, SiteModel } from "./types.js";

/** A parameter only the site or the session supplies: never an agent input. */
export function hiddenParam(param: Param): boolean {
  return (
    param.in === "header" ||
    param.in === "cookie" ||
    param.constant !== undefined ||
    Boolean(param.generated) ||
    Boolean(param.persistedHash) ||
    isDerived(param)
  );
}

/** The parameters an agent passes, in order. */
export function visibleParams(operation: Operation): Param[] {
  return operation.params.filter((param) => !hiddenParam(param));
}

/** A parameter is required only when the call cannot work without it and no default fills it. */
export function paramRequired(param: Param): boolean {
  if (param.default !== undefined) return false;
  return param.in === "path" || param.required;
}

const SKIP_WORD = /^(api|rest|v\d+|gql|graphql|rpc|json|ajax|data|query|_next|internal|public)$/i;
const HASH_LIKE = /^[A-Za-z0-9_-]{16,}$/;

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** The resource words of a path: /api/v2/products/{id}/reviews → ["products", "reviews"]. */
function resourceWords(operation: Operation): string[] {
  const parts = (operation.path.split("?")[0] ?? "").split("/").filter(Boolean);
  return parts
    .filter((part) => !/^\{.*\}$/.test(part) && !SKIP_WORD.test(part) && !HASH_LIKE.test(part))
    .flatMap(words)
    .filter((word) => !SKIP_WORD.test(word));
}

function graphqlName(operation: Operation): string | undefined {
  return operation.graphql?.operationName ?? operation.match?.graphql?.operationName;
}

function verbOf(operation: Operation): string {
  const method = operation.method.toUpperCase();
  const last = operation.path.split("?")[0]?.split("/").filter(Boolean).at(-1) ?? "";
  if (method === "DELETE") return "Delete";
  if (method === "PATCH" || method === "PUT") return "Update";
  if (operation.role === "action") return method === "POST" ? "Create" : "Change";
  if (operation.capabilities?.includes("search")) return "Search";
  if (
    visibleParams(operation).some((param) => /^(q|query|term|search|keywords?)$/i.test(param.name))
  )
    return "Search";
  return /^\{.*\}$/.test(last) ? "Get" : "List";
}

function responseSchema(operation: Operation): JsonSchema | undefined {
  const ok = Object.entries(operation.responses).find(([status]) => /^2/.test(status));
  return ok?.[1].schema;
}

/** The top keys of the answer: an object's fields, or the fields of a list's items. */
export function responseKeys(operation: Operation, limit = 5): string[] {
  let schema = responseSchema(operation);
  if (schema?.type === "array") schema = schema.items as JsonSchema | undefined;
  const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  return Object.keys(properties).slice(0, limit);
}

/** A description in words: the summary, or "Search products, returns id, name". */
export function describeOperation(operation: Operation): string {
  const summary = operation.summary?.trim();
  if (summary && !looksMechanical(summary, operation)) return summary;
  const name = graphqlName(operation);
  const noun = name
    ? words(name).join(" ")
    : resourceWords(operation).join(" ") || operation.id.replace(/([a-z])([A-Z])/g, "$1 $2");
  const head = name ? `Run the ${noun} query` : `${verbOf(operation)} ${noun}`;
  const keys = responseKeys(operation);
  return keys.length ? `${head}, returns ${keys.join(", ")}` : head;
}

/** A summary that only repeats the method, path or host says nothing an agent can choose by. */
function looksMechanical(summary: string, operation: Operation): boolean {
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i.test(summary)) return true;
  if (summary.includes(operation.path)) return true;
  try {
    if (summary.includes(new URL(operation.origin).host)) return true;
  } catch {
    // an origin that is not a URL: nothing to compare
  }
  return /\b\d{1,3}(\.\d{1,3}){3}\b|localhost/i.test(summary);
}

/** The read that returns a value for this id input: listProducts for productId. */
export function producerOf(
  model: Pick<SiteModel, "operations">,
  operation: Operation,
  name: string,
): string | undefined {
  const traced = operation.dependencies?.find(
    (dependency) =>
      dependency.source.kind === "response" && dependency.target.replace(/^\w+:/, "") === name,
  )?.source as { operationId?: string } | undefined;
  if (traced?.operationId && traced.operationId !== operation.id) return traced.operationId;
  const noun = /^(.+?)_?id$/i.exec(name)?.[1]?.toLowerCase();
  if (!noun) return undefined;
  const reads = model.operations.filter(
    (other) =>
      other.id !== operation.id &&
      other.role === "read" &&
      !visibleParams(other).some((param) => param.in === "path"),
  );
  const named = (other: Operation) =>
    resourceWords(other).some(
      (word) => word === noun || word === `${noun}s` || word === `${noun}es`,
    );
  return reads.find(named)?.id;
}

/** What a call fills in when the caller leaves it out: "limit=20, sort=new". */
export function filledDefaults(operation: Operation): string[] {
  const fromParams = visibleParams(operation)
    .filter((param) => param.default !== undefined)
    .map((param) => `${param.name}=${String(param.default).slice(0, 40)}`);
  const fromBody = Object.entries(operation.requestBody?.defaults ?? {}).map(
    ([name, value]) => `${name}=${String(value).slice(0, 40)}`,
  );
  return [...fromParams, ...fromBody];
}

/** One input's description: a default, an example, and where an id comes from. */
export function paramDescription(
  model: Pick<SiteModel, "operations">,
  operation: Operation,
  param: Param,
): string {
  const example = param.examples?.[0];
  const producer = /id$/i.test(param.name) ? producerOf(model, operation, param.name) : undefined;
  return [
    param.default !== undefined
      ? `optional, defaults to ${String(param.default).slice(0, 60)}`
      : paramRequired(param)
        ? "required"
        : "optional",
    example !== undefined ? `e.g. ${example.slice(0, 60)}` : "",
    producer ? `get it from ${producer}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** How to call this one operation: what to pass, and what the call fills in by itself. */
export function howToCallFor(operation: Operation): string {
  const defaults = filledDefaults(operation);
  const fill = defaults.length
    ? `Left out, these are filled with what the site sent: ${defaults.join(", ")}.`
    : "Nothing optional is filled in.";
  const pages = operation.pagination
    ? " Pass maxItems to read every page up to that many items."
    : "";
  return `Pass the listed inputs by name. ${fill}${pages}`;
}
