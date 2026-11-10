import type { BrowserSemanticNode } from "@browserkit/protocol";
import type { AxNode, AxRef } from "../native-browser-common.js";
import { buildSemanticTree } from "./tree.js";
import { renderState } from "./render.js";
import { VIEW_CHAR_LIMIT, clampBudget, type ExpandSection, type ResolvedClickable } from "./types.js";

export function attachClickables(
  semantic: { refs: Map<string, AxRef>; nodes: BrowserSemanticNode[] },
  hits: readonly ResolvedClickable[],
  query?: string,
): void {
  const used = new Set(semantic.nodes.map((node) => node.backendNodeId));
  let next = nextRef(semantic.nodes);
  const needle = query?.toLowerCase();
  for (const hit of hits) {
    if (semantic.nodes.length >= 220 || used.has(hit.backendNodeId)) continue;
    if (needle && !`clickable ${hit.text}`.toLowerCase().includes(needle)) continue;
    const ref = `e${next}`;
    next += 1;
    const name = hit.text.slice(0, 80);
    semantic.refs.set(ref, { backendNodeId: hit.backendNodeId, role: "clickable", name });
    semantic.nodes.push({ ref, backendNodeId: hit.backendNodeId, role: "clickable", name });
    used.add(hit.backendNodeId);
  }
}

function nextRef(nodes: readonly BrowserSemanticNode[]): number {
  let max = -1;
  for (const node of nodes) {
    const match = /e(\d+)$/.exec(node.ref);
    const value = match?.[1] ? Number(match[1]) : -1;
    if (value > max) max = value;
  }
  return max + 1;
}

export function renderCaptured(input: {
  ax: readonly AxNode[];
  shown: readonly BrowserSemanticNode[];
  url: string;
  title?: string;
  clickables: readonly ResolvedClickable[];
  offscreen: readonly string[];
  budget?: number;
  focus?: string;
  delta?: Set<number>;
  expand?: ExpandSection[];
  truncated: boolean;
}): string {
  const budget = clampBudget(input.budget);
  const tree = buildSemanticTree({
    ax: input.ax,
    shown: input.shown,
    url: input.url,
    ...(input.title ? { title: input.title } : {}),
    clickables: input.clickables,
    offscreen: input.offscreen,
  });
  const view = renderState(tree, {
    budget,
    ...(input.focus ? { focus: input.focus } : {}),
    ...(input.delta ? { delta: input.delta } : {}),
    ...(input.expand?.length ? { expand: input.expand } : {}),
  });
  const noted = noteTruncation(view, input.truncated, budget);
  return noted.length > VIEW_CHAR_LIMIT ? noted.slice(0, VIEW_CHAR_LIMIT) : noted;
}

function noteTruncation(view: string, truncated: boolean, budget: number): string {
  if (!truncated || view.includes("page.state({query})")) return view;
  const note = "[observation truncated; page.state({query}) for a focused look]";
  const next = view ? `${view}\n${note}` : note;
  return next.length <= budget ? next : view;
}
