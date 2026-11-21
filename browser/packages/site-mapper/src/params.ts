// Which parameters are the caller's, and which the site supplies itself. One place, so listings,
// the spec, the typed client and MCP tools never ask for a value nobody can pass.

import type { Operation, Param } from "./types.js";

const SESSION_HEADER =
  /^(authorization|x-csrf-token|x-xsrf-token|csrf-token|x-xsrftoken|x-csrftoken)$/i;

/**
 * A value the site's own code supplies: a signature the page's JavaScript builds, a nonce, or a
 * sign-in header taken from the session. Passing one by hand is never right.
 */
export function isDerived(param: Param): boolean {
  if (param.derived) return true;
  return param.in === "header" && SESSION_HEADER.test(param.name);
}

/** The parameters a caller supplies (ops listings, MCP tool inputs, the typed client). */
export function inputParams(operation: Operation): Param[] {
  return operation.params.filter(
    (param) => param.constant === undefined && !param.generated && !isDerived(param),
  );
}

/** The parameters the spec documents: constants and generated values stay, derived ones never do. */
export function documentedParams(operation: Operation): Param[] {
  return operation.params.filter((param) => !isDerived(param));
}

/** The request body's top-level fields a caller supplies: those that varied, not recorded constants. */
export function bodyInputs(operation: Operation): string[] {
  const properties = (operation.requestBody?.schema.properties ?? {}) as Record<string, unknown>;
  const constants = operation.requestBody?.constants ?? {};
  return Object.keys(properties).filter((name) => !(name in constants));
}

/** Everything a caller supplies for an operation: its parameters, then its varying body fields. */
export function operationInputs(operation: Operation): string[] {
  return [
    ...new Set([...inputParams(operation).map((param) => param.name), ...bodyInputs(operation)]),
  ];
}
