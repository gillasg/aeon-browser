// The delta baseline belongs to bu.state (pin), not to every observe. A snapshot taken
// while acting must not make the cell's final state look unchanged.

interface PinNode {
  backendNodeId?: number | undefined;
  role: string;
  name: string;
  value?: string | undefined;
  disabled?: boolean | undefined;
  checked?: boolean | undefined;
  expanded?: boolean | undefined;
  selected?: boolean | undefined;
  pressed?: boolean | "mixed" | undefined;
}

const pins = new Map<string, Map<number, string>>();

function fingerprint(node: PinNode): string {
  return [
    node.role,
    node.name,
    node.value ?? "",
    node.disabled === true,
    node.checked === true,
    node.expanded === true,
    node.selected === true,
    node.pressed ?? "",
  ].join("|");
}

/** Ids whose role, name, value or state differ from the pinned render. Undefined when there is no pin yet. */
export function changedIds(
  key: string,
  nodes: readonly PinNode[],
  delta: boolean,
): Set<number> | undefined {
  if (!delta) return undefined;
  const previous = pins.get(key);
  if (!previous) return undefined;
  const changed = new Set<number>();
  const seen = new Set<number>();
  for (const node of nodes) {
    const id = node.backendNodeId;
    if (typeof id !== "number") continue;
    seen.add(id);
    if (previous.get(id) !== fingerprint(node)) changed.add(id);
  }
  for (const id of previous.keys()) if (!seen.has(id)) changed.add(id);
  return changed;
}

export function rememberNodes(key: string, nodes: readonly PinNode[], pin: boolean): void {
  if (!pin) return;
  const next = new Map<number, string>();
  for (const node of nodes) {
    if (typeof node.backendNodeId === "number") next.set(node.backendNodeId, fingerprint(node));
  }
  pins.set(key, next);
  while (pins.size > 32) {
    const oldest = pins.keys().next().value;
    if (oldest === undefined) break;
    pins.delete(oldest);
  }
}
