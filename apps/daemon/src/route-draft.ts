// Fills FirstTurn.routeDraft for a rung 1 start. Rung 0 carries no draft: nothing is left for
// the model to edit.

export interface RouteDraft {
  site: string;
  summary: string;
  cell: string;
  ranAt: string;
}

/** Hidden `[draft]` block. The user's own words are not part of it. */
export function draftBlock(draft: RouteDraft): string {
  return `[draft]\n${draft.site}\n${draft.summary}\n${draft.ranAt}\n${draft.cell}`;
}

/** The block alone. With no draft, the prompt is unchanged. */
export function draftPrompt(prompt: string, draft: RouteDraft | undefined): string {
  if (!draft) return prompt;
  return draftBlock(draft);
}

export function fillRouteDraft(
  route: { site: string; summary: string; cell: string; lastOkAt: string } | undefined,
  rung: 0 | 1,
): RouteDraft | undefined {
  if (!route || rung !== 1) return undefined;
  return { site: route.site, summary: route.summary, cell: route.cell, ranAt: route.lastOkAt };
}
