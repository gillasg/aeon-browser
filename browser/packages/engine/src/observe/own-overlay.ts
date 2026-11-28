import type { AxNode } from "../native-browser-common.js";
import { textValue } from "../native-browser-common.js";

// A safety net behind the overlay's own backend ids: when the cursor's controls still reach the
// accessibility tree (a closed shadow root re-rendered mid-snapshot, a frame that mirrors it),
// they are recognised by their exact names and dropped with the controls that sit beside them.

/** The names only Graft's working pill gives its buttons. */
const OWN_NAMES = new Set(["Open the transcript in the side panel", "Open the transcript"]);
/** Controls that share the pill with the transcript button. */
const PILL_NAMES = new Set(["Stop", "Pause", "Resume", "Take over", "Hand back"]);

const nameOf = (node: AxNode) => textValue(node.name?.value).replace(/\s+/g, " ").trim();
const roleOf = (node: AxNode) => textValue(node.role?.value).toLowerCase();

/** The AX nodes with Graft's own overlay controls (and their pill siblings) left out. */
export function dropOwnOverlayNodes(ax: AxNode[]): AxNode[] {
  const pills = new Set<string>();
  for (const node of ax)
    if (roleOf(node) === "button" && OWN_NAMES.has(nameOf(node)) && node.parentId)
      pills.add(node.parentId);
  if (!pills.size) return ax;
  const dropped = new Set<string>();
  for (const node of ax) {
    if (!node.nodeId) continue;
    const name = nameOf(node);
    const inPill = node.parentId !== undefined && pills.has(node.parentId);
    if (inPill && (OWN_NAMES.has(name) || PILL_NAMES.has(name) || !name)) dropped.add(node.nodeId);
  }
  // Text under a dropped control goes with it.
  return ax.filter((node) => {
    if (node.nodeId && dropped.has(node.nodeId)) return false;
    return !(node.parentId && dropped.has(node.parentId));
  });
}
