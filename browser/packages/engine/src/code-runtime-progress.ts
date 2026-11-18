// Progress is for the live activity view; images and full observations wait for the result.
// An opened tab's target stays whole, so a cell that times out still reports, and hands its chat,
// the tab it opened.
export function progressSteps(
  steps: Record<string, unknown>[],
  max: number,
): Record<string, unknown>[] {
  return steps.slice(-max).map(({ result, ...rest }) => {
    const value = result as { kind?: unknown; tab?: { target?: unknown } } | undefined;
    const target = value?.kind === "tab" ? value.tab?.target : undefined;
    return {
      ...rest,
      ...(value ? { result: { kind: value.kind, ...(target ? { tab: { target } } : {}) } } : {}),
    };
  });
}
