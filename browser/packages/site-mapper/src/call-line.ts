import type { Operation, Param } from "./types.js";

/** A caller-supplied input: not fixed, made up by the client, or filled in by the site. */
function callerParam(param: Param): boolean {
  if (param.in !== "path" && param.in !== "query") return false;
  return param.constant === undefined && !param.generated && !param.derived;
}

/** The first value seen in the recording for each input the caller passes. */
function observedParams(op: Operation): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const param of op.params.filter(callerParam)) {
    const value = param.examples?.[0];
    if (value !== undefined) params[param.name] = value;
  }
  for (const variable of op.graphql?.variables ?? []) {
    const value = variable.constant === undefined ? variable.examples?.[0] : undefined;
    if (value !== undefined) params[variable.name] = value;
  }
  return params;
}

/**
 * The one runnable line printed after mapping: `aeon call <site> <firstRead> '<observed params>'`,
 * filled with values seen in the recording. Undefined when the site has no read to call.
 */
export function firstCallLine(site: string, operations: Operation[]): string | undefined {
  const reads = operations.filter((item) => item.role === "read");
  const op = reads.find((item) => item.bucket === "high") ?? reads[0];
  if (!op) return undefined;
  const json = JSON.stringify(observedParams(op)).replace(/'/g, "'\\''");
  return `aeon call ${site} ${op.id} '${json}'`;
}
