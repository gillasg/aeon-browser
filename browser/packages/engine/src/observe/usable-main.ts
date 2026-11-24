import type { AxNode } from "../native-browser-common.js";
import { textValue } from "../native-browser-common.js";
import type { TreeNode } from "./types.js";

// A page with an open modal often makes everything behind it inert (<main inert>) or
// aria-hidden. That main is not where the user can act: snapshots must not put the modal's
// controls under it or rank its content first. With no usable main, the page body is the scope.

function prop(node: AxNode, name: string): unknown {
  return node.properties?.find((item) => item.name === name)?.value?.value;
}

/** An AX node the user cannot reach: ignored, hidden or inert. */
export function axUnreachable(node: AxNode): boolean {
  if (node.ignored === true) return true;
  const hidden = prop(node, "hidden");
  if (hidden === true || hidden === "true") return true;
  const inert = prop(node, "inert");
  return inert === true || inert === "true";
}

function isMain(node: AxNode): boolean {
  return textValue(node.role?.value).toLowerCase() === "main";
}

/** AX ids of every main landmark that sits in (or is) an inert or aria-hidden subtree. */
export function unusableMainIds(ax: readonly AxNode[]): Set<string> {
  const byId = new Map(ax.flatMap((node) => (node.nodeId ? [[node.nodeId, node] as const] : [])));
  const out = new Set<string>();
  for (const node of ax) {
    if (!node.nodeId || !isMain(node)) continue;
    let at: AxNode | undefined = node;
    for (let depth = 0; at && depth < 200; depth++) {
      if (axUnreachable(at)) {
        out.add(node.nodeId);
        break;
      }
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
  }
  return out;
}

/** The first main the user can act in, or undefined: then the scope is the page body. */
export function usableMain(
  nodes: readonly TreeNode[],
  ax: readonly AxNode[] = [],
): TreeNode | undefined {
  const unusable = unusableMainIds(ax);
  const byAx = new Map(nodes.map((node) => [node.axId, node] as const));
  return nodes.find((node) => {
    if (node.role !== "main" || node.hidden === true || unusable.has(node.axId)) return false;
    for (let at = node.parentAxId, depth = 0; at && depth < 200; depth++) {
      const parent = byAx.get(at);
      if (!parent) break;
      if (parent.hidden === true) return false;
      at = parent.parentAxId;
    }
    return true;
  });
}

export interface OutsideFrame {
  origin?: string;
  name?: string;
}

/** Iframes that are not inside the usable main, named by origin and title when known. */
export function framesOutsideMain(
  ax: readonly AxNode[],
  mainAxId: string | undefined,
  frameUrls: ReadonlyMap<string, string> = new Map(),
): OutsideFrame[] {
  const byId = new Map(ax.flatMap((node) => (node.nodeId ? [[node.nodeId, node] as const] : [])));
  const inside = (node: AxNode): boolean => {
    for (let at: AxNode | undefined = node, depth = 0; at && depth < 200; depth++) {
      if (at.nodeId === mainAxId) return true;
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    return false;
  };
  const rootFrame = ax[0]?.frameId;
  const frames: OutsideFrame[] = [];
  for (const node of ax) {
    if (textValue(node.role?.value).toLowerCase() !== "iframe") continue;
    if (mainAxId && inside(node)) continue;
    const url = (node.frameOwner && frameUrls.get(node.frameOwner)) || frameRootUrl(ax, node);
    const origin = hostOf(url);
    const name = textValue(node.name?.value).trim();
    frames.push({
      ...(origin && origin !== hostOf(rootUrl(ax, rootFrame)) ? { origin } : {}),
      ...(name ? { name: name.slice(0, 40) } : {}),
    });
  }
  return frames;
}

function frameRootUrl(ax: readonly AxNode[], owner: AxNode): string | undefined {
  if (!owner.frameOwner) return undefined;
  return rootUrl(ax, owner.frameOwner);
}

function rootUrl(ax: readonly AxNode[], frameId: string | undefined): string | undefined {
  if (!frameId) return undefined;
  const root = ax.find(
    (node) =>
      node.frameId === frameId && textValue(node.role?.value).toLowerCase() === "rootwebarea",
  );
  const url = root ? prop(root, "url") : undefined;
  return typeof url === "string" ? url : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The scope line: `Scoped to main; outside it: 2 iframes (checkout.example.com "Payment",
 * youtube.com)`, or the body when main is inert or hidden behind an open dialog.
 */
export function mainScopeNote(
  scope: "main" | "body",
  hadInertMain: boolean,
  outside: readonly OutsideFrame[],
): string | undefined {
  const named = outside.filter((frame) => frame.origin);
  const list = named
    .slice(0, 4)
    .map((frame) => [frame.origin, frame.name ? `"${frame.name}"` : ""].filter(Boolean).join(" "));
  const frames = list.length
    ? `; outside it: ${outside.length} iframe${outside.length === 1 ? "" : "s"} (${list.join(", ")})`
    : "";
  if (scope === "body")
    return hadInertMain ? "Scoped to body: main is inert or hidden behind a dialog" : undefined;
  return frames ? `Scoped to main${frames}` : undefined;
}
