/** Keep operation outcomes parseable when verbose browser observations exceed the UI budget. */
export function compactBrowserResult(text: string, budget: number): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      typeof value.operationId !== "string" ||
      typeof value.toolCallId !== "string" ||
      !Array.isArray(value.steps)
    )
      return undefined;
    if (
      !value.steps.every(
        (step) =>
          isRecord(step) && typeof step.index === "number" && typeof step.disposition === "string",
      )
    )
      return undefined;
    for (const limit of [12, 0]) {
      const projected = JSON.stringify({ ...compactValue(value, limit), truncated: true });
      if (projected.length <= budget) return projected;
    }
    return JSON.stringify({
      operationId: value.operationId,
      toolCallId: value.toolCallId,
      truncated: true,
      steps: value.steps.map((step) => {
        const record = step as Record<string, unknown>;
        return {
          index: record.index,
          disposition: record.disposition,
          code: record.code,
          action: record.action,
          result:
            isRecord(record.result) && isRecord(record.result.scroll)
              ? { kind: record.result.kind, scroll: record.result.scroll }
              : undefined,
          resultOmitted: record.result !== undefined,
        };
      }),
    });
  } catch {
    return undefined;
  }
}

function compactValue(value: Record<string, unknown>, limit: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "nodes" || key === "tabs") && Array.isArray(item)) {
      output[key] = item.slice(0, limit).map((entry: unknown) => compactItem(entry, limit));
      if (item.length > limit) output.truncated = true;
    } else output[key] = compactItem(item, limit);
  }
  return output;
}

function compactItem(value: unknown, limit: number): unknown {
  if (typeof value === "string") return value.slice(0, 1024);
  if (Array.isArray(value)) return value.map((item: unknown) => compactItem(item, limit));
  if (isRecord(value)) return compactValue(value, limit);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
