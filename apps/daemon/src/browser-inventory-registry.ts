import {
  BrowserInventoryDeltaMessageSchema,
  BrowserInventoryFullSchema,
  type BrowserInventoryDeltaMessage,
  type BrowserInventoryFull,
  type BrowserTab,
  type BrowserTargetKey,
  type BrowserWindow,
} from "@aeon/protocol";

interface Snapshot {
  browserRunId: string;
  generation: number;
  lastSequence: number;
  windows: Map<number, BrowserWindow>;
  tabs: Map<number, BrowserTab>;
}

export class BrowserInventoryRegistry {
  private readonly clients = new Map<string, Snapshot>();

  applyFull(candidate: unknown): BrowserInventoryFull | undefined {
    const parsed = BrowserInventoryFullSchema.safeParse(candidate);
    if (!parsed.success || !validFull(parsed.data)) return undefined;
    const next = parsed.data;
    const current = this.clients.get(next.clientInstanceId);
    if (current?.browserRunId === next.browserRunId && current.generation >= next.generation)
      return undefined;
    this.clients.set(next.clientInstanceId, {
      browserRunId: next.browserRunId,
      generation: next.generation,
      lastSequence: 0,
      windows: new Map(next.windows.map((item) => [item.windowId, item])),
      tabs: new Map(next.tabs.map((item) => [item.target.tabId, item])),
    });
    return next;
  }

  applyDelta(candidate: unknown): { applied: boolean; expectedSequence: number } | undefined {
    const parsed = BrowserInventoryDeltaMessageSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    const message = parsed.data;
    const current = this.clients.get(message.clientInstanceId);
    if (!current || current.browserRunId !== message.browserRunId) return undefined;
    if (current.generation !== message.generation)
      return { applied: false, expectedSequence: current.lastSequence + 1 };
    if (message.sequence !== current.lastSequence + 1)
      return { applied: false, expectedSequence: current.lastSequence + 1 };
    if (!validDelta(message, current)) return undefined;
    applyToSnapshot(message, current);
    current.lastSequence = message.sequence;
    return { applied: true, expectedSequence: current.lastSequence + 1 };
  }

  get(clientInstanceId: string): BrowserInventoryFull | undefined {
    const current = this.clients.get(clientInstanceId);
    if (!current) return undefined;
    return {
      kind: "browser.inventory.full",
      clientInstanceId,
      browserRunId: current.browserRunId,
      generation: current.generation,
      windows: [...current.windows.values()],
      tabs: [...current.tabs.values()],
    };
  }

  findTarget(target: BrowserTargetKey): BrowserTab | undefined {
    const tab = this.clients.get(target.clientInstanceId)?.tabs.get(target.tabId);
    return tab && sameKey(tab.target, target) ? tab : undefined;
  }
}

function validFull(inventory: BrowserInventoryFull): boolean {
  const windows = new Set(inventory.windows.map((item) => item.windowId));
  if (windows.size !== inventory.windows.length) return false;
  const tabIds = new Set<number>();
  for (const tab of inventory.tabs) {
    if (
      tab.target.clientInstanceId !== inventory.clientInstanceId ||
      tab.target.browserRunId !== inventory.browserRunId ||
      !windows.has(tab.windowId) ||
      tabIds.has(tab.target.tabId)
    )
      return false;
    tabIds.add(tab.target.tabId);
  }
  return true;
}

function validDelta(message: BrowserInventoryDeltaMessage, current: Snapshot): boolean {
  const { delta } = message;
  if (delta.kind === "tab.upsert") {
    if (!keyMatches(delta.tab.target, message) || !current.windows.has(delta.tab.windowId))
      return false;
    const previous = current.tabs.get(delta.tab.target.tabId);
    return (
      !previous ||
      !sameKey(previous.target, delta.tab.target) ||
      delta.tab.documentEpoch >= previous.documentEpoch
    );
  }
  if (delta.kind === "tab.remove") return keyMatches(delta.target, message);
  return true;
}

function keyMatches(key: BrowserTargetKey, message: BrowserInventoryDeltaMessage): boolean {
  return (
    key.clientInstanceId === message.clientInstanceId && key.browserRunId === message.browserRunId
  );
}

function applyToSnapshot(message: BrowserInventoryDeltaMessage, current: Snapshot): void {
  const { delta } = message;
  if (delta.kind === "tab.upsert") current.tabs.set(delta.tab.target.tabId, delta.tab);
  else if (delta.kind === "tab.remove") {
    const tab = current.tabs.get(delta.target.tabId);
    if (tab && sameKey(tab.target, delta.target)) current.tabs.delete(delta.target.tabId);
  } else if (delta.kind === "window.upsert")
    current.windows.set(delta.window.windowId, delta.window);
  else if (delta.kind === "window.remove") {
    current.windows.delete(delta.windowId);
    for (const [tabId, tab] of current.tabs)
      if (tab.windowId === delta.windowId) current.tabs.delete(tabId);
  }
}

function sameKey(left: BrowserTargetKey, right: BrowserTargetKey): boolean {
  return (
    left.clientInstanceId === right.clientInstanceId &&
    left.browserRunId === right.browserRunId &&
    left.tabId === right.tabId &&
    left.tabIncarnation === right.tabIncarnation
  );
}
