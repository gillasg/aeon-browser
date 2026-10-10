export const browserErrorGuidance =
  "After TARGET_NOT_FOUND, inspect a focused snapshot or read selector and choose another locator; do not repeat the same guess. AMBIGUOUS_TARGET requires a unique CSS scope. TARGET_HIDDEN/BLOCKED means inspect overlays or wait for visibility. TARGET_DISABLED/NOT_EDITABLE requires the actual editable control. INPUT_FAILED means inspect its value before proceeding. STALE_REF requires a fresh snapshot/screenshot. After two failures of the same approach, change strategy; do not loop. Verify the requested outcome before reporting success.";

export function browserFailure(output: string): boolean {
  try {
    const value = JSON.parse(output) as { error?: unknown; steps?: { disposition?: string }[] };
    return Boolean(value.error || value.steps?.some((step) => step.disposition === "failed"));
  } catch {
    return true;
  }
}

// Shared by both browser tools in one session. Inspection does not erase a failed action streak.
export function createBrowserProgressGuard(): (step: unknown, failed?: boolean) => void {
  const failures = new Map<string, { count: number; at: number }>();
  return (step, failed) => {
    const action = step as { op: string };
    if (!["click", "fill", "press", "scroll", "navigate"].includes(action.op)) return;
    const identity = { ...(step as Record<string, unknown>) };
    delete identity.observe;
    const key = JSON.stringify(identity);
    const prior = failures.get(key);
    if (failed === undefined) {
      if (prior && prior.count >= 2 && Date.now() - prior.at < 120_000)
        throw new Error(
          "NO_PROGRESS: this action failed twice. Inspect the page and change the locator or strategy before retrying.",
        );
    } else if (failed) {
      failures.set(key, {
        count: prior && Date.now() - prior.at < 120_000 ? prior.count + 1 : 1,
        at: Date.now(),
      });
      while (failures.size > 64) failures.delete(failures.keys().next().value ?? "");
    } else failures.delete(key);
  };
}

export function compactBrowserTrace(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const item = result as Record<string, unknown>;
  if (item.kind === "semantic") {
    const { nodes, text, ...metadata } = item;
    const excerpt = typeof text === "string" ? text.slice(0, 3000) : undefined;
    return {
      ...metadata,
      ...(excerpt ? { text: excerpt, textClipped: excerpt.length !== String(text).length } : {}),
      nodeCount: Array.isArray(nodes) ? nodes.length : 0,
    };
  }
  if (item.kind === "action")
    return { ...item, observation: compactBrowserTrace(item.observation) };
  if (item.kind === "page")
    return {
      ...item,
      data: {
        omitted: true,
        message:
          "Read data is available to the workflow; return the fields needed in its final value.",
      },
    };
  return result;
}
