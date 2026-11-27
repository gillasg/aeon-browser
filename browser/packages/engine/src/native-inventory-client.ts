import {
  BrowserTabSchema,
  BrowserWindowSchema,
  type BrowserTab,
  type BrowserWindow,
  BrowserInventoryDeltaMessageSchema,
  BrowserInventoryFullSchema,
  BrowserInventoryReplySchema,
  type BrowserInventoryDeltaMessage,
} from "@browserkit/protocol";
import type { BrowserIdentity } from "./native-worker-identity.js";
import { graftUiPage } from "./native-browser-common.js";
import { handoffFor } from "./native-browser-handoff-state.js";

export type TabIdentity = { tabIncarnation: string; documentEpoch: number };

export function toInventoryWindow(window: chrome.windows.Window): BrowserWindow {
  const state = window.state ?? "normal";
  return BrowserWindowSchema.parse({
    windowId: window.id,
    focused: window.focused ?? false,
    state: ["normal", "minimized", "maximized", "fullscreen"].includes(state) ? state : "normal",
    type: window.type === "popup" ? "popup" : "normal",
  });
}

export function toInventoryTab(
  tab: chrome.tabs.Tab,
  identity: BrowserIdentity,
  state: TabIdentity,
): BrowserTab {
  return BrowserTabSchema.parse({
    target: {
      ...inventoryIdentity(identity),
      tabId: tab.id as number,
      tabIncarnation: state.tabIncarnation,
    },
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url ?? "",
    title: tab.title ?? "",
    status: tab.discarded ? "discarded" : tab.status === "complete" ? "complete" : "loading",
    active: tab.active,
    pinned: tab.pinned,
    groupId: tab.groupId ?? -1,
    documentEpoch: state.documentEpoch,
    // The daemon lists and gates Graft's own pages by this mark: only the engine knows its own id.
    ...(graftUiPage(tab.url ?? "") ? { graftUi: true } : {}),
    // A pending hand-off rides the inventory, so the daemon's status can say "Waiting on you".
    ...handoffField(tab.id),
  });
}

function handoffField(tabId: number | undefined): {
  handoff?: { message: string; startedAt: number };
} {
  const status = tabId === undefined ? undefined : handoffFor(tabId);
  return status ? { handoff: { message: status.message, startedAt: status.startedAt } } : {};
}

export function inventoryIdentity(identity: BrowserIdentity): BrowserIdentity {
  return { clientInstanceId: identity.clientInstanceId, browserRunId: identity.browserRunId };
}

const GENERATION_KEY = "graft-inventory-generation";
const TAB_MAP_KEY = "graft-tab-incarnations";
type Change = () => Promise<void>;
interface InventorySession extends BrowserIdentity {
  socket: WebSocket;
  generation: number;
  sequence: number;
  initializing: boolean;
  queued: Change[];
  chain: Promise<void>;
  windows: Map<number, BrowserWindow>;
  tabs: Map<number, BrowserTab>;
  /** Tab refreshes queued and not started yet: a later event for the tab joins the queued one. */
  pending: Map<number, PendingUpsert>;
}
interface PendingUpsert {
  navigated: boolean;
  /** Events merged into this refresh; a merged loading-to-complete cycle still counts as a load. */
  events: number;
  done: Promise<void>;
}

let active: InventorySession | undefined;
let listenersInstalled = false;
export async function synchronizeBrowserInventory(
  socket: WebSocket,
  identity: BrowserIdentity,
): Promise<void> {
  installListeners();
  const stored = await chrome.storage.session.get(GENERATION_KEY);
  const previous = stored[GENERATION_KEY];
  const generation =
    (Number.isSafeInteger(previous) && Number(previous) >= 0 ? Number(previous) : 0) + 1;
  await chrome.storage.session.set({ [GENERATION_KEY]: generation });
  const session: InventorySession = {
    ...identity,
    socket,
    generation,
    sequence: 0,
    initializing: true,
    queued: [],
    chain: Promise.resolve(),
    windows: new Map(),
    tabs: new Map(),
    pending: new Map(),
  };
  active = session;
  socket.addEventListener(
    "close",
    () => {
      if (active === session) active = undefined;
    },
    { once: true },
  );
  const inventory = await buildFullInventory(session);
  session.windows = new Map(inventory.windows.map((window) => [window.windowId, window]));
  session.tabs = new Map(inventory.tabs.map((tab) => [tab.target.tabId, tab]));
  await sendAndWait(
    socket,
    inventory,
    (reply) =>
      reply.kind === "browser.inventory.applied" &&
      reply.generation === generation &&
      reply.lastSequence === 0,
  );
  session.initializing = false;
  for (const change of session.queued.splice(0)) enqueue(session, change);
  await session.chain;
}

export function currentInventoryTabs(): readonly BrowserTab[] {
  return [...(active?.tabs.values() ?? [])];
}

/** The window the user last focused, whose active tab browser.activeTab() means. */
export function currentFocusedWindowId(): number | undefined {
  return focusedWindowId([...(active?.windows.values() ?? [])]);
}

/** The last focused window's id; a pure selector so the focus rule can be tested. */
export function focusedWindowId(windows: readonly BrowserWindow[]): number | undefined {
  return windows.find((window) => window.focused)?.windowId;
}

/**
 * Queues one tab refresh on the shared inventory chain. That chain serialises every tab change
 * for every chat (including daemon acknowledgement round trips), so an engine-wide read such as
 * browser.tabs() must not wait for the whole backlog: a caller that only needs current state can
 * pass `maxWaitMs` and get the tab as it is now if the chain is busy. The queued work still runs
 * in order; only this caller stops waiting for it.
 */
export async function refreshInventoryTab(
  tabId: number,
  maxWaitMs?: number,
): Promise<BrowserTab | undefined> {
  const session = active;
  if (!session) return undefined;
  const work = queueUpsert(session, tabId, false);
  if (maxWaitMs === undefined) await work;
  else await withTimeout(work, maxWaitMs);
  return active === session ? session.tabs.get(tabId) : undefined;
}

/** A bounded wait that never cancels `work`; a caller that gives up just reads current state. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => resolve(undefined as T), ms);
    work.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  chrome.tabs.onCreated.addListener((tab) => queueTab(tab.id, false));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) =>
    queueTab(tabId, changeInfo.url !== undefined || changeInfo.status === "loading"),
  );
  chrome.tabs.onMoved.addListener((tabId) => queueTab(tabId, false));
  chrome.tabs.onAttached.addListener((tabId) => queueTab(tabId, false));
  chrome.tabs.onActivated.addListener(({ tabId }) => queueTab(tabId, false));
  chrome.tabs.onRemoved.addListener((tabId) => queue(() => removeTab(tabId)));
  chrome.tabs.onReplaced.addListener((addedId, removedId) =>
    queue(async () => {
      await removeTab(removedId);
      const map = await readTabMap();
      delete map[String(addedId)];
      await writeTabMap(map);
      await upsertTab(addedId);
    }),
  );
  chrome.windows.onCreated.addListener((window) => queue(() => upsertWindow(window.id)));
  chrome.windows.onRemoved.addListener((windowId) => queue(() => removeWindow(windowId)));
  chrome.windows.onFocusChanged.addListener(() => queue(refreshWindows));
}

function queue(change: Change): void {
  if (active) enqueue(active, change);
}

function queueTab(tabId: number | undefined, navigated: boolean): void {
  if (active && tabId !== undefined) void queueUpsert(active, tabId, navigated);
}

/**
 * One refresh of a tab on the shared chain. A tab that loads fires many updates; while one refresh
 * for it waits its turn, later updates join it instead of each adding a refresh (and two daemon
 * round trips) to the chain that every tab's steps wait behind.
 */
function queueUpsert(session: InventorySession, tabId: number, navigated: boolean): Promise<void> {
  const waiting = session.initializing ? undefined : session.pending.get(tabId);
  if (waiting) {
    waiting.navigated ||= navigated;
    waiting.events += 1;
    return waiting.done;
  }
  const entry: PendingUpsert = { navigated, events: 1, done: Promise.resolve() };
  const change = () => {
    if (session.pending.get(tabId) === entry) session.pending.delete(tabId);
    return upsertTab(tabId, entry.navigated, entry.events > 1);
  };
  if (session.initializing) {
    session.queued.push(change);
    return Promise.resolve();
  }
  session.pending.set(tabId, entry);
  entry.done = session.chain = session.chain
    .then(change)
    .catch(() => session.socket.close(4001, "Inventory sync required"));
  return entry.done;
}

function enqueue(session: InventorySession, change: Change): void {
  if (session.initializing) session.queued.push(change);
  else
    session.chain = session.chain
      .then(change)
      .catch(() => session.socket.close(4001, "Inventory sync required"));
}

async function buildFullInventory(session: InventorySession) {
  const [windowsRaw, tabsRaw] = await Promise.all([
    chrome.windows.getAll({ populate: false }),
    chrome.tabs.query({}),
  ]);
  const windows = windowsRaw
    .filter((window) => window.id !== undefined && !window.incognito)
    .map((window) => toInventoryWindow(window));
  const windowIds = new Set(windows.map((window) => window.windowId));
  const tabs = tabsRaw.filter(
    (tab) =>
      tab.id !== undefined &&
      tab.windowId !== undefined &&
      !tab.incognito &&
      windowIds.has(tab.windowId),
  );
  const liveIds = new Set(tabs.map((tab) => String(tab.id)));
  const tabMap = await readTabMap();
  for (const id of Object.keys(tabMap)) if (!liveIds.has(id)) delete tabMap[id];
  const inventoryTabs: BrowserTab[] = tabs.map((tab) => {
    const tabId = tab.id as number;
    const state = identityFor(tabMap, tabId);
    return toInventoryTab(tab, session, state);
  });
  await writeTabMap(tabMap);
  return BrowserInventoryFullSchema.parse({
    kind: "browser.inventory.full",
    ...inventoryIdentity(session),
    generation: session.generation,
    capabilities: ["site-scripts", "browser-actions-v2", "browser-runtime-v4", "browser-code-v1"],
    windows,
    tabs: inventoryTabs,
  });
}

async function upsertTab(
  tabId: number | undefined,
  navigated = false,
  merged = false,
): Promise<void> {
  const session = active;
  if (!session || tabId === undefined) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!isInventoryTab(tab)) return removeTab(tabId);
  const map = await readTabMap();
  const before = JSON.stringify(map[String(tabId)] ?? null);
  const state = identityFor(map, tabId);
  const previous = session.tabs.get(tabId);
  if (shouldAdvanceDocumentEpoch(navigated, previous, tab, merged)) state.documentEpoch += 1;
  if (JSON.stringify(map[String(tabId)]) !== before) await writeTabMap(map);
  await upsertWindow(tab.windowId);
  const next = toInventoryTab(tab, session, state);
  // The daemon already has this exact tab: no delta, no round trip.
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
  await emit(session, { kind: "tab.upsert", tab: next });
}

function isInventoryTab(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & {
  windowId: number;
} {
  return tab !== undefined && tab.windowId !== undefined && !tab.incognito;
}

export function shouldAdvanceDocumentEpoch(
  navigated: boolean,
  previous: Pick<BrowserTab, "status" | "url"> | undefined,
  tab: Pick<chrome.tabs.Tab, "status" | "url">,
  merged = false,
): boolean {
  // A load that began and finished between two refreshes leaves the status as it was: a refresh
  // that merged a navigation with later updates still saw a new document.
  const cycled = merged && previous?.status === "complete" && tab.status === "complete";
  return Boolean(
    (navigated && (previous?.status !== tab.status || cycled)) ||
    (previous && previous.url !== (tab.url ?? "")),
  );
}

async function removeTab(tabId: number): Promise<void> {
  const session = active;
  if (!session) return;
  const tab = session.tabs.get(tabId);
  const map = await readTabMap();
  delete map[String(tabId)];
  await writeTabMap(map);
  if (tab) await emit(session, { kind: "tab.remove", target: tab.target });
}

async function upsertWindow(windowId: number | undefined): Promise<void> {
  const session = active;
  if (!session || windowId === undefined) return;
  const window = await chrome.windows.get(windowId).catch(() => undefined);
  if (!window || window.incognito || window.id === undefined) return;
  const next = toInventoryWindow(window);
  const known = session.windows.get(next.windowId);
  if (known && JSON.stringify(known) === JSON.stringify(next)) return;
  await emit(session, { kind: "window.upsert", window: next });
}

async function refreshWindows(): Promise<void> {
  const session = active;
  if (!session) return;
  const windows = await chrome.windows.getAll({ populate: false });
  for (const window of windows)
    if (window.id !== undefined && !window.incognito) await upsertWindow(window.id);
}

async function removeWindow(windowId: number): Promise<void> {
  const session = active;
  if (!session) return;
  for (const [tabId, tab] of session.tabs) if (tab.windowId === windowId) await removeTab(tabId);
  await emit(session, { kind: "window.remove", windowId });
}

async function emit(
  session: InventorySession,
  delta: BrowserInventoryDeltaMessage["delta"],
): Promise<void> {
  if (active !== session) return;
  const message = BrowserInventoryDeltaMessageSchema.parse({
    kind: "browser.inventory.delta",
    ...inventoryIdentity(session),
    generation: session.generation,
    sequence: session.sequence + 1,
    delta,
  });
  const reply = await sendAndWait(
    session.socket,
    message,
    (candidate) =>
      candidate.kind === "browser.inventory.applied" &&
      candidate.generation === session.generation &&
      candidate.lastSequence === message.sequence,
  );
  if (reply.kind !== "browser.inventory.applied") throw new Error("Inventory sequence gap.");
  session.sequence = message.sequence;
  if (delta.kind === "tab.upsert") session.tabs.set(delta.tab.target.tabId, delta.tab);
  else if (delta.kind === "tab.remove") session.tabs.delete(delta.target.tabId);
  else if (delta.kind === "window.upsert") session.windows.set(delta.window.windowId, delta.window);
  else if (delta.kind === "window.remove") session.windows.delete(delta.windowId);
}

function sendAndWait(
  socket: WebSocket,
  value: unknown,
  accepts: (reply: ReturnType<typeof BrowserInventoryReplySchema.parse>) => boolean,
): Promise<ReturnType<typeof BrowserInventoryReplySchema.parse>> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => finish(new Error("Inventory acknowledgement timed out.")),
      5000,
    );
    const finish = (
      error?: Error,
      reply?: ReturnType<typeof BrowserInventoryReplySchema.parse>,
    ) => {
      globalThis.clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else if (reply) resolve(reply);
      else reject(new Error("Invalid inventory acknowledgement."));
    };
    const onClose = () => finish(new Error("Daemon closed inventory sync."));
    const onMessage = (event: MessageEvent) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data)) as unknown;
      } catch {
        return;
      }
      const parsed = BrowserInventoryReplySchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.kind === "browser.inventory.resync")
        return finish(new Error("Inventory resync required."));
      if (accepts(parsed.data)) finish(undefined, parsed.data);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.send(JSON.stringify(value));
  });
}

async function readTabMap(): Promise<Record<string, TabIdentity>> {
  const result = await chrome.storage.session.get(TAB_MAP_KEY);
  const value = result[TAB_MAP_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, TabIdentity>)
    : {};
}

async function writeTabMap(value: Record<string, TabIdentity>): Promise<void> {
  await chrome.storage.session.set({ [TAB_MAP_KEY]: value });
}

function identityFor(map: Record<string, TabIdentity>, tabId: number): TabIdentity {
  const key = String(tabId);
  const prior = map[key];
  if (
    prior &&
    typeof prior.tabIncarnation === "string" &&
    Number.isSafeInteger(prior.documentEpoch)
  )
    return prior;
  return (map[key] = { tabIncarnation: crypto.randomUUID(), documentEpoch: 0 });
}
