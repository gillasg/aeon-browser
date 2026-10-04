export async function onNode<T>(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
  fn: (...args: never[]) => unknown,
  args: unknown[] = [],
): Promise<T> {
  const resolved = (await chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", {
    backendNodeId,
  })) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("STALE_REF");
  try {
    const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error("STALE_REF");
    return result.result?.value as T;
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}

export function nodeState(this: HTMLElement): {
  visible: boolean;
  enabled: boolean;
  editable: boolean;
} {
  const box = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  return {
    visible:
      this.isConnected &&
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none",
    enabled: !this.matches(":disabled,[aria-disabled='true']") && !this.closest("[inert]"),
    editable:
      this.matches("input:not([readonly]),textarea:not([readonly])") || this.isContentEditable,
  };
}

export async function visibleNodes(
  debuggee: chrome.debugger.Debuggee,
  ids: number[],
): Promise<number[]> {
  if (ids.length > 100) throw new Error("AMBIGUOUS_TARGET");
  const result: number[] = [];
  for (const id of ids.slice(0, 100)) {
    const state = await onNode<{ visible: boolean }>(debuggee, id, nodeState).catch(
      () => undefined,
    );
    if (state?.visible) result.push(id);
  }
  return result;
}

export async function scopedBackendIds(
  debuggee: chrome.debugger.Debuggee,
  selector: string,
): Promise<Set<number>> {
  const ids = await queryNodes(debuggee, { by: "css", value: selector });
  if (ids.length !== 1) throw new Error(ids.length ? "AMBIGUOUS_TARGET" : "TARGET_NOT_FOUND");
  interface DomNode {
    backendNodeId?: number;
    children?: DomNode[];
    shadowRoots?: DomNode[];
    contentDocument?: DomNode;
  }
  const result = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
    backendNodeId: ids[0],
    depth: -1,
    pierce: true,
  })) as { node?: DomNode };
  const selected = new Set<number>();
  const pending: DomNode[] = result.node ? [result.node] : [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (node.backendNodeId !== undefined) selected.add(node.backendNodeId);
    pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.contentDocument) pending.push(node.contentDocument);
  }
  return selected;
}

interface Query {
  by: string;
  value: string;
  exact?: boolean | undefined;
  scope?: string | undefined;
}
export async function queryNodes(
  debuggee: chrome.debugger.Debuggee,
  query: Query,
): Promise<number[]> {
  const group = `aeon-query-${crypto.randomUUID()}`;
  try {
    const evaluated = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `(${findElements.toString()})(${JSON.stringify(query)})`,
      objectGroup: group,
    })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    if (evaluated.exceptionDetails) throw new Error("INVALID_TARGET");
    if (!evaluated.result?.objectId) return [];
    return await backendIds(debuggee, evaluated.result.objectId);
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group })
      .catch(() => undefined);
  }
}
async function backendIds(debuggee: chrome.debugger.Debuggee, objectId: string) {
  const properties = (await chrome.debugger.sendCommand(debuggee, "Runtime.getProperties", {
    objectId,
    ownProperties: true,
  })) as { result?: { name: string; value?: { objectId?: string } }[] };
  const ids: number[] = [];
  for (const property of properties.result ?? []) {
    if (!/^\d+$/.test(property.name) || !property.value?.objectId) continue;
    const described = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
      objectId: property.value.objectId,
    })) as { node?: { backendNodeId?: number } };
    if (described.node?.backendNodeId !== undefined) ids.push(described.node.backendNodeId);
  }
  return ids;
}
function findElements(query: Query): Element[] {
  const roots: (Document | ShadowRoot | Element)[] = [document];
  const elements: Element[] = [];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) continue;
    for (const element of root.querySelectorAll("*")) {
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const scopeSelector = query.scope;
  const scopes = scopeSelector ? elements.filter((el) => el.matches(scopeSelector)) : [];
  if (query.scope && scopes.length !== 1) throw Error("Scope must match one element");
  const scopeElement = scopes[0];
  const scoped = scopeElement ? elements.filter((el) => scopeElement.contains(el)) : elements;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const matches = (text: string) =>
    query.exact === false
      ? normalize(text).toLowerCase().includes(normalize(query.value).toLowerCase())
      : normalize(text) === normalize(query.value);
  return scoped.filter((el) => matchElement(el, query, matches)).slice(0, 101);
  function matchElement(el: Element, q: Query, match: (text: string) => boolean): boolean {
    if (q.by === "css") return el.matches(q.value);
    if (q.by === "placeholder") return match(el.getAttribute("placeholder") ?? "");
    if (q.by === "label") {
      const label = labelText(el);
      return Boolean(label) && match(label);
    }
    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
    return (
      match(text) &&
      ![...el.children].some((child) =>
        match((child as HTMLElement).innerText ?? child.textContent ?? ""),
      )
    );
  }
  function labelText(el: Element): string {
    const control = el as HTMLInputElement;
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/);
    const labelled = ids
      .map((id) =>
        el.getRootNode() instanceof Document
          ? (document.getElementById(id)?.textContent ?? "")
          : "",
      )
      .join(" ");
    const label =
      el.getAttribute("aria-label") ||
      labelled.trim() ||
      [...(control.labels ?? [])].map((item) => item.textContent).join(" ");

    return label;
  }
}
