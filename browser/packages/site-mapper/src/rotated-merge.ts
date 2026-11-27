// A re-visit after a deploy records the same GraphQL operation under a new persisted hash. That
// is the same operation, not a second one: the newer recording replaces the older under the
// older id, so the catalog never keeps a dead twin next to the working one.

import type { Operation, SiteModel } from "./types.js";

function nameOf(op: Operation): string | undefined {
  if (op.kind !== "graphql") return undefined;
  const name = op.graphql?.operationName ?? op.match?.graphql?.operationName;
  return name ? `${op.method.toUpperCase()} ${op.origin} ${name}` : undefined;
}

function groupByName(operations: readonly Operation[]): Operation[][] {
  const groups = new Map<string, Operation[]>();
  for (const op of operations) {
    const key = nameOf(op);
    if (key) groups.set(key, [...(groups.get(key) ?? []), op]);
  }
  return [...groups.values()];
}

/**
 * Folds same-name GraphQL operations into one. The one the previous save did not have is the
 * newer recording; with no previous save, the later one in the model wins. The kept id is the
 * one the previous save knew (or the first one).
 */
export function mergeRotated(model: SiteModel, previous: SiteModel | undefined): SiteModel {
  const known = new Set(previous?.operations.map((op) => op.id) ?? []);
  const replace = new Map<string, Operation>();
  const drop = new Set<string>();
  for (const ops of groupByName(model.operations)) {
    const [first] = ops;
    const last = ops.at(-1);
    if (ops.length < 2 || !first || !last) continue;
    const keep = ops.find((op) => known.has(op.id)) ?? first;
    const fresh = [...ops].reverse().find((op) => !known.has(op.id)) ?? last;
    for (const op of ops) if (op !== keep) drop.add(op.id);
    replace.set(keep.id, { ...fresh, id: keep.id });
  }
  if (!replace.size) return model;
  return {
    ...model,
    operations: model.operations
      .filter((op) => !drop.has(op.id))
      .map((op) => replace.get(op.id) ?? op),
  };
}
