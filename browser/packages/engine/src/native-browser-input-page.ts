// Page-side helpers for an input target: what sits on top of the element, the point a real click
// must hit, and the fallback of activating the node in the DOM. They are passed to onNode, so they
// run in the page and must stay self-contained.

// Names what sits on top of the target, so the agent acts in the open dialog or closes the
// overlay instead of retrying the covered control.
function coveringElement(this: HTMLElement): string {
  const box = this.getBoundingClientRect();
  const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
  const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
  const hit = (this.getRootNode() as Document | ShadowRoot).elementFromPoint(x, y);
  if (!hit) return "";
  const layer =
    hit.closest(
      "dialog,[role=dialog],[role=alertdialog],[role=listbox],[role=menu],[aria-modal]",
    ) ?? hit;
  const label = (el: Element) =>
    (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const role = layer.getAttribute("role") || layer.tagName.toLowerCase();
  const fields = [...layer.querySelectorAll("input,textarea,select,[role=combobox]")]
    .slice(0, 5)
    .map((el) => `"${label(el) || el.getAttribute("name") || "field"}"`);
  const parts = [`covered by ${role} "${label(layer)}"`];
  if (fields.length) parts.push(`its fields: ${fields.join(", ")}`);
  parts.push("act inside it (bu.state() shows its ids) or close it first");
  return parts.join("; ");
}
// DOM-level activation for a target that cannot be hit-tested and has no reachable label.
function activateNode(this: HTMLElement): void {
  if (typeof this.click === "function") this.click();
  else this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
// Brings the target into view inside its nearest scrollable container (dialogs, panels, lists).
function scrollNearest(this: HTMLElement): void {
  this.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function hitPoint(this: HTMLElement) {
  const box = this.getBoundingClientRect();
  const left = Math.max(0, box.left),
    top = Math.max(0, box.top);
  const right = Math.min(innerWidth, box.right),
    bottom = Math.min(innerHeight, box.bottom);
  const x = (left + right) / 2,
    y = (top + bottom) / 2;
  const root = this.getRootNode() as Document | ShadowRoot;
  const hit = root.elementFromPoint(x, y);
  const covered = right > left && bottom > top && !!hit;
  const direct = covered && (hit === this || this.contains(hit));
  // Coordinates stay in this frame; the engine adds each owner iframe's box when it sends Input
  // on the root session (frameElement is null inside a cross-origin frame).
  if (!covered || direct || !ancestorOf(hit, this)) return { x, y, hit: direct };
  // The target sits inside the element that is hit but cannot be hit itself (hidden or
  // pointer-events:none control): use its label if that is reachable, else activate it in the DOM.
  const label = labelOf(this);
  const lbox = label?.getBoundingClientRect();
  const lx = lbox ? lbox.left + lbox.width / 2 : 0,
    ly = lbox ? lbox.top + lbox.height / 2 : 0;
  const lhit =
    label && lbox && lbox.width > 0 && lbox.height > 0 ? root.elementFromPoint(lx, ly) : null;
  if (label && lhit && (lhit === label || label.contains(lhit))) return { x: lx, y: ly, hit: true };
  return { x, y, hit: true, activate: true };
  function ancestorOf(other: Element | null, target: Element): boolean {
    let node: Node | null = target;
    while (node && other) {
      if (node === other) return true;
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return false;
  }
  function labelOf(target: HTMLElement): HTMLElement | null {
    const labels = (target as HTMLInputElement).labels;
    if (labels?.length) return labels[0] as HTMLElement;
    const wrapping = target.closest("label");
    if (wrapping) return wrapping;
    const ref = target.getAttribute("aria-labelledby")?.split(" ")[0];
    return ref ? (root.getElementById?.(ref) ?? null) : null;
  }
}

// Page-side: the point to click for an element in a frame. A target inside the element that is hit
// (hidden or pointer-events:none control) is clicked through its label, else activated in the DOM.
function framePoint(this: HTMLElement): { x: number; y: number; activated?: boolean } {
  this.scrollIntoView({ block: "center", inline: "center" });
  const box = this.getBoundingClientRect();
  if (!box.width || !box.height || this.matches(':disabled,[aria-disabled="true"]'))
    throw Error("TARGET_DISABLED");
  const at = (x: number, y: number) => {
    let hit = this.ownerDocument.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint(x, y);
      if (!next || next === hit) break;
      hit = next;
    }
    return hit;
  };
  const x = box.left + box.width / 2,
    y = box.top + box.height / 2;
  const hit = at(x, y);
  if (hit === this || (hit && this.contains(hit))) return { x, y };
  let ancestor = false;
  for (let node: Node | null = this; node && hit; node = node.parentNode)
    if (node === hit) ancestor = true;
  if (!ancestor) throw Error("TARGET_BLOCKED");
  const label =
    (this as unknown as HTMLInputElement).labels?.[0] ?? this.closest("label") ?? undefined;
  const lbox = label?.getBoundingClientRect();
  if (label && lbox && lbox.width && lbox.height) {
    const lx = lbox.left + lbox.width / 2,
      ly = lbox.top + lbox.height / 2;
    const lhit = at(lx, ly);
    if (lhit && (lhit === label || label.contains(lhit))) return { x: lx, y: ly };
  }
  this.click();
  return { x, y, activated: true };
}

export { coveringElement, activateNode, scrollNearest, hitPoint, framePoint };
