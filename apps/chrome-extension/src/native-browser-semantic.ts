import type { BrowserSemanticNode } from "@pippin/protocol";
import { booleanProperty, textValue, type AxNode, type AxRef } from "./native-browser-common.js";

const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "option",
  "treeitem",
  "listbox",
  "menuitemcheckbox",
  "menuitemradio",
]);
interface Options {
  query?: string | undefined;
  interactive?: boolean | undefined;
}
export function filterVisibleTextNodes(nodes: AxNode[], visibleText: string): AxNode[] {
  const normalized = visibleText.replace(/\s+/g, " ").toLowerCase();
  return nodes.filter((node) => {
    if (!["statictext", "heading", "paragraph"].includes(textValue(node.role?.value).toLowerCase()))
      return true;
    const text = textValue(node.name?.value).replace(/\s+/g, " ").trim().toLowerCase();
    return !text || normalized.includes(text);
  });
}
function relevant(node: AxNode, options: Options): boolean {
  const role = textValue(node.role?.value).toLowerCase();
  const name = textValue(node.name?.value).trim();
  if (node.ignored || node.backendDOMNodeId === undefined || !role) return false;
  if (options.interactive && !interactiveRoles.has(role)) return false;
  if (!name && !interactiveRoles.has(role)) return false;
  if (["generic", "none", "presentation", "inlinetextbox"].includes(role)) return false;
  return !options.query || `${role} ${name}`.toLowerCase().includes(options.query.toLowerCase());
}
function priority(node: AxNode): number {
  if (booleanProperty(node, "focused").focused) return 0;
  const role = textValue(node.role?.value).toLowerCase();
  if (["textbox", "searchbox", "combobox"].includes(role)) return 1;
  if (role === "button") return 2;
  return interactiveRoles.has(role) ? 3 : 4;
}
export function createSemanticNodes(
  nodes: AxNode[],
  options: Options = {},
): { refs: Map<string, AxRef>; nodes: BrowserSemanticNode[]; truncated: boolean } {
  const candidates = nodes.filter((node) => relevant(node, options));
  const selected = new Set([...candidates].sort((a, b) => priority(a) - priority(b)).slice(0, 180));
  const refs = new Map<string, AxRef>();
  const compact: BrowserSemanticNode[] = [];
  for (const node of candidates) {
    if (!selected.has(node)) continue;
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId === undefined) continue;
    const role = textValue(node.role?.value).slice(0, 80);
    const name = textValue(node.name?.value).trim().slice(0, 512);
    const ref = `e${compact.length}`;
    refs.set(ref, { backendNodeId: backendNodeId, role, name });
    compact.push({
      ref,
      backendNodeId,
      role,
      name,
      ...(node.value ? { value: textValue(node.value.value).slice(0, 512) } : {}),
      ...booleanProperty(node, "disabled"),
      ...booleanProperty(node, "checked"),
      ...booleanProperty(node, "focused"),
      ...booleanProperty(node, "expanded"),
      ...booleanProperty(node, "selected"),
      ...booleanProperty(node, "pressed"),
      ...(node.properties?.some((p) => p.name === "pressed" && p.value?.value === "mixed")
        ? { pressed: "mixed" as const }
        : {}),
      ...(node.properties?.some((p) => p.name === "checked" && p.value?.value === "mixed")
        ? { mixed: true }
        : {}),
    });
  }
  return { refs, nodes: compact, truncated: candidates.length > compact.length };
}
