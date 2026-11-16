// A chat event is written by the engine, the adapter and the daemon, and parsed by a view with a
// stricter schema. When a producer adds a field before the schema catches up, the unknown field
// itself is the whole problem: drop just that field, keep the event, and log it. A value that is
// wrong or missing is not repaired here.

export interface ParseIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  keys?: readonly string[];
}

/**
 * The value with the keys zod called unrecognized removed. The original is never changed; a value
 * that cannot be cloned is returned as-is so the caller's parse still fails cleanly.
 */
export function withoutUnknownKeys<T>(value: T, issues: readonly ParseIssue[]): T {
  let copy: T;
  try {
    copy = structuredClone(value);
  } catch {
    return value;
  }
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys" || !issue.keys?.length) continue;
    const target = objectAt(copy, issue.path);
    if (!target) continue;
    for (const key of issue.keys) delete target[key];
  }
  return copy;
}

function objectAt(
  root: unknown,
  path: readonly PropertyKey[],
): Record<PropertyKey, unknown> | undefined {
  let current = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as Record<PropertyKey, unknown>)
    : undefined;
}
