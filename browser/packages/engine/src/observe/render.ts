import type { RenderOptions, SemanticTree } from "./types.js";
import { hotNodes, buildLines } from "./render-build.js";
import { fitBudget, prepareLines } from "./render-budget.js";
import { paint } from "./render-model.js";

export type { RenderOptions, SemanticTree } from "./types.js";
export { pageHeading, sameSitePath } from "./render-model.js";

/** Renders a semantic tree. Dialogs come first; nav and footer stay one line unless expanded. */
export function renderState(tree: SemanticTree, options: RenderOptions): string {
  const budget = options.budget;
  const hot = hotNodes(tree.nodes, options.focus, options.delta);
  const built = buildLines(tree, options.expand ?? [], hot);
  const prepared = prepareLines(built, options.focus, options.delta);
  const fitted = fitBudget(prepared.lines, budget, prepared.hidden);
  const text = paint(fitted);
  return text.length > budget ? text.slice(0, budget) : text;
}
