import type { AxNode } from "../native-browser-common.js";
import { textValue } from "../native-browser-common.js";

// A date picker cell is often div[role=button] whose visible name is just "4" while its child
// carries aria-label="Friday, December 4, 2026". The state shows the child's full label on the
// control, so the agent can click the day it means without scraping the DOM.

const CONTROL_ROLES = new Set(["button", "gridcell", "option", "link", "menuitem", "tab"]);
const SHORT = 3;

/** AX node id → a fuller label found on a descendant, for controls whose own name is short. */
export function nestedLabels(nodes: readonly AxNode[]): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const node of nodes)
    if (node.nodeId && node.parentId) parentOf.set(node.nodeId, node.parentId);
  const short = new Map<string, string>();
  for (const node of nodes) {
    const role = textValue(node.role?.value).toLowerCase();
    const name = textValue(node.name?.value).trim();
    if (node.nodeId && CONTROL_ROLES.has(role) && name.length <= SHORT)
      short.set(node.nodeId, name);
  }
  const out = new Map<string, string>();
  if (!short.size) return out;
  for (const node of nodes) {
    const label = textValue(node.name?.value).replace(/\s+/g, " ").trim();
    if (label.length <= SHORT || !node.nodeId) continue;
    // The nearest short control above this node, within three levels.
    let at = node.parentId;
    for (let depth = 0; at && depth < 3; depth++, at = parentOf.get(at)) {
      const own = short.get(at);
      if (own === undefined) continue;
      if (!out.has(at) && (!own || label.includes(own))) out.set(at, label.slice(0, 200));
      break;
    }
  }
  return out;
}
