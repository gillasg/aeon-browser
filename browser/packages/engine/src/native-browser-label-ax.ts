import { textValue, type AxNode } from "./native-browser-common.js";

/** Roles that take a label: what `getByLabel` means when the DOM cannot see the control. */
const LABELLED_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "button",
  "menuitemcheckbox",
  "menuitemradio",
]);

/**
 * The accessibility tree pierces closed shadow roots, where a page-side DOM walk cannot. A
 * `<label for>`, aria-label or aria-labelledby already surfaces as the control's accessible
 * name, so a label miss in the DOM is retried against form-control names here. Headings and
 * static text never match: only a labelled control is a label target.
 */
export function labelAxMatches(nodes: AxNode[], value: string, exact = true): AxNode[] {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const wanted = normalize(value);
  if (!wanted) return [];
  return nodes.filter((node) => {
    if (node.ignored || node.backendDOMNodeId === undefined) return false;
    if (!LABELLED_ROLES.has(textValue(node.role?.value).toLowerCase())) return false;
    const name = normalize(textValue(node.name?.value));
    return exact ? name === wanted : name.toLowerCase().includes(wanted.toLowerCase());
  });
}
