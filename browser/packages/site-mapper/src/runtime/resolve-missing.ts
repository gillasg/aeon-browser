import { getPointer } from "../infer/schema.js";
import type { Operation } from "../types.js";
import { dependencyFor, MissingParams, SET, type Params, type RuntimeResponse } from "./request.js";

/** Looks up an operation and calls it, so a missing input can be filled without owning the client. */
export interface MissingInputHost {
  operation(id: string): Operation;
  request(id: string, params: Params, depth: number): Promise<RuntimeResponse>;
}

/**
 * Fills inputs the caller left out. A traced write is not called: a recorded constant is reused,
 * a required input with no constant stays missing, and an optional one is left out.
 */
export async function fillMissingInputs(
  operation: Operation,
  params: Params,
  missing: string[],
  depth: number,
  host: MissingInputHost,
): Promise<Params> {
  if (depth > 3) throw new MissingParams(operation, missing);
  const sets: Params = { ...((params[SET] as Params | undefined) ?? {}) };
  const unresolved: string[] = [];
  for (const target of missing) {
    const filled = await fillOne(operation, params, target, depth, host, sets);
    if (filled === "missing") unresolved.push(target);
  }
  if (unresolved.length) throw new MissingParams(operation, unresolved);
  return { ...params, [SET]: sets };
}

/** One missing input: skip, keep a constant, or read the value from the operation that produces it. */
async function fillOne(
  operation: Operation,
  params: Params,
  target: string,
  depth: number,
  host: MissingInputHost,
  sets: Params,
): Promise<"ok" | "missing"> {
  const dep = dependencyFor(operation, target);
  if (!dep) return "missing";
  const source = host.operation(dep.source.operationId);
  if (source.role !== "read") return constantOrMissing(operation, target, sets);
  const response = await host.request(dep.source.operationId, params, depth + 1);
  const value = getPointer(response.json, dep.source.pointer.replace(/\*/g, "0"));
  if (value === undefined) return "missing";
  sets[target] = value;
  return "ok";
}

/** A write dependency is not called. Use its recorded constant, or leave a required input missing. */
function constantOrMissing(operation: Operation, target: string, sets: Params): "ok" | "missing" {
  const param = operation.params.find((item) => `${item.in}:${item.name}` === target);
  if (param?.constant !== undefined) {
    sets[target] = param.constant;
    return "ok";
  }
  return param?.required ? "missing" : "ok";
}
