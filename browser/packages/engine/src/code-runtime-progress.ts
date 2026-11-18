// Progress is for the live activity view; images and full observations wait for the result.
// An opened tab's id stays, so a cell that times out still reports the tab it opened.
export function progressSteps(
  steps: Record<string, unknown>[],
  max: number,
): Record<string, unknown>[] {
  return steps.slice(-max).map(({ result, ...rest }) => {
    const value = result as { kind?: unknown; tab?: { target?: { tabId?: unknown } } } | undefined;
    const tabId = value?.kind === "tab" ? value.tab?.target?.tabId : undefined;
    return {
      ...rest,
      ...(value
        ? {
            result: {
              kind: value.kind,
              ...(typeof tabId === "number" ? { tab: { target: { tabId } } } : {}),
            },
          }
        : {}),
    };
  });
}
