// page.notifications: service worker push messages, shown notifications, app badges and title
// unread counts for one tab, scrubbed and kept in a bounded ring. Strictly lazy: BackgroundService
// and ServiceWorker are enabled only between start() (or waitFor()) and stop() / tab close.
import { send } from "./cdp/send.js";
import { holdBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { publishBrowserEvent } from "./native-browser-events.js";
import {
  Ring,
  installTap,
  readFilter,
  removeTap,
  scrubText,
  scrubValue,
  waitMs,
  type RealtimeItem,
} from "./native-browser-realtime.js";

export type PushKind = "push" | "notification" | "badge" | "title";
export interface PushEvent extends RealtimeItem {
  kind: PushKind;
  title?: string;
  count?: number | null;
  event?: string;
  details?: unknown;
}
interface TabPush {
  ring: Ring<PushEvent>;
  tap: string;
  badge: number | null;
  unread: number | null;
}

export const PUSH_EVENT = "Aeon.pushEvent";
const BINDING = "__aeonPushTap";
const SERVICES = ["pushMessaging", "notifications"] as const;
const tabs = new Map<number, TabPush>();
const listeners = new Set<(tabId: number, event: PushEvent) => void>();

export function onPushEvent(listener: (tabId: number, event: PushEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pushActive(tabId: number): boolean {
  return tabs.has(tabId);
}

interface RawPush {
  kind: PushKind;
  url?: string;
  title?: unknown;
  body?: unknown;
  count?: unknown;
  event?: string;
  details?: unknown;
}

function countOf(value: unknown): number | null {
  const count = Number(value);
  return value === null || value === undefined || !Number.isFinite(count) ? null : count;
}

function noteCounts(entry: TabPush, raw: RawPush): number | null | undefined {
  if (raw.kind === "badge") return (entry.badge = countOf(raw.count));
  if (raw.kind !== "title") return undefined;
  const count = countOf(raw.count);
  const before = entry.unread;
  entry.unread = count;
  return before === count ? undefined : count;
}

/** Stores one scrubbed event and tells watchers. Exported for the CDP-free tests. */
export function recordPush(tabId: number, raw: RawPush): PushEvent | undefined {
  const entry = tabs.get(tabId);
  if (!entry) return undefined;
  const count = noteCounts(entry, raw);
  if (raw.kind === "title" && count === undefined) return undefined;
  const body = typeof raw.body === "string" ? scrubText(raw.body).slice(0, 2000) : "";
  const event = entry.ring.push({
    at: Date.now(),
    kind: raw.kind,
    url: scrubText(raw.url ?? ""),
    data: body,
    ...(typeof raw.title === "string" ? { title: scrubText(raw.title).slice(0, 500) } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(raw.event ? { event: raw.event } : {}),
    ...(raw.details === undefined ? {} : { details: scrubValue(raw.details) }),
  });
  for (const listener of listeners) listener(tabId, event);
  publishBrowserEvent(tabId, PUSH_EVENT, event as unknown as Record<string, unknown>);
  return event;
}

type Params = Record<string, unknown>;

function serviceEvent(params: Params): RawPush | undefined {
  const event = (params.backgroundServiceEvent ?? {}) as Params;
  const service = String(event.service ?? "");
  if (service !== "pushMessaging" && service !== "notifications") return undefined;
  const metadata: Record<string, string> = {};
  for (const item of (event.eventMetadata ?? []) as { key?: string; value?: string }[])
    if (item.key) metadata[item.key] = String(item.value ?? "");
  return {
    kind: service === "pushMessaging" ? "push" : "notification",
    url: String(event.origin ?? ""),
    event: String(event.eventName ?? ""),
    title: metadata.title,
    body: metadata.body ?? metadata.data ?? metadata.payload,
    details: metadata,
  };
}

function tapEvent(params: Params): RawPush | undefined {
  if (params.name !== BINDING) return undefined;
  try {
    const message = JSON.parse(String(params.payload)) as Params;
    const kind = String(message.kind);
    if (!["notification", "badge", "title"].includes(kind)) return undefined;
    return {
      kind: kind as PushKind,
      url: String(message.url ?? ""),
      title: message.title,
      body: message.body,
      count: message.count,
      event: String(message.event ?? kind),
      ...(message.tag ? { details: { tag: message.tag } } : {}),
    };
  } catch {
    return undefined;
  }
}

export function pushDebuggerEvent(tabId: number, method: string, params: Params): void {
  if (!tabs.has(tabId)) return;
  const raw =
    method === "BackgroundService.backgroundServiceEventReceived"
      ? serviceEvent(params)
      : method === "Runtime.bindingCalled"
        ? tapEvent(params)
        : undefined;
  if (raw) recordPush(tabId, raw);
}

// Page hooks: the Badging API, Notification and showNotification, and "(3) Inbox" title counts.
function tapSource(): string {
  return `(() => {
  if (window.__aeonPushTapped) return;
  window.__aeonPushTapped = true;
  const tell = (message) => { try { const fn = window[${JSON.stringify(BINDING)}]; if (fn) fn(JSON.stringify({url: location.href, ...message})); } catch {} };
  const nav = navigator;
  if (nav.setAppBadge) { const set = nav.setAppBadge.bind(nav); nav.setAppBadge = (count) => { tell({kind: 'badge', event: 'set', count: count ?? null}); return set(count); }; }
  if (nav.clearAppBadge) { const clear = nav.clearAppBadge.bind(nav); nav.clearAppBadge = () => { tell({kind: 'badge', event: 'clear', count: 0}); return clear(); }; }
  if (window.Notification) {
    const Native = window.Notification;
    const Wrapped = function (title, options = {}) { tell({kind: 'notification', event: 'show', title: String(title), body: String(options.body ?? ''), tag: options.tag}); return new Native(title, options); };
    Wrapped.prototype = Native.prototype;
    Object.defineProperty(Wrapped, 'permission', {get: () => Native.permission});
    Wrapped.requestPermission = Native.requestPermission.bind(Native);
    window.Notification = Wrapped;
  }
  if (window.ServiceWorkerRegistration) {
    const proto = ServiceWorkerRegistration.prototype, show = proto.showNotification;
    proto.showNotification = function (title, options = {}) { tell({kind: 'notification', event: 'show', title: String(title), body: String(options.body ?? ''), tag: options.tag}); return show.apply(this, arguments); };
  }
  const unread = () => { const found = /^\\s*[(\\[](\\d+)\\+?[)\\]]/.exec(document.title); tell({kind: 'title', title: document.title, count: found ? Number(found[1]) : null}); };
  const watch = () => { const head = document.head || document.documentElement; if (!head) return; new MutationObserver(unread).observe(head, {subtree: true, childList: true, characterData: true}); unread(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, {once: true}); else watch();
})();`;
}

async function start(tabId: number): Promise<unknown> {
  const found = tabs.get(tabId);
  if (found) return { observing: true, events: found.ring.items.length };
  const entry: TabPush = { ring: new Ring(), tap: "", badge: null, unread: null };
  tabs.set(tabId, entry);
  holdBrowserDebugger(tabId, true);
  const label = "notifications";
  for (const service of SERVICES)
    await send({ tabId }, "BackgroundService.startObserving", { service }, { label });
  await send({ tabId }, "ServiceWorker.enable", undefined, { label });
  entry.tap = await installTap(tabId, BINDING, tapSource());
  return { observing: true, events: 0 };
}

async function teardown(tabId: number, entry: TabPush): Promise<void> {
  const label = "notifications";
  for (const service of SERVICES)
    await send({ tabId }, "BackgroundService.stopObserving", { service }, { label }).catch(
      () => undefined,
    );
  await send({ tabId }, "ServiceWorker.disable", undefined, { label }).catch(() => undefined);
  await removeTap(tabId, BINDING, entry.tap);
}

export async function stopPush(tabId: number): Promise<{ stopped: boolean }> {
  const entry = tabs.get(tabId);
  if (!entry) return { stopped: false };
  tabs.delete(tabId);
  entry.ring.close();
  await teardown(tabId, entry);
  holdBrowserDebugger(tabId, false);
  return { stopped: true };
}

export async function pushCall(tabId: number, action: string, options: Params) {
  if (action === "start") return start(tabId);
  if (action === "stop") return stopPush(tabId);
  if (action === "state")
    return { observing: tabs.has(tabId), events: tabs.get(tabId)?.ring.items.length ?? 0 };
  if (action === "waitFor") {
    if (!tabs.has(tabId)) await start(tabId);
    return tabs.get(tabId)?.ring.waitFor(readFilter(options), waitMs(options)) ?? null;
  }
  const entry = tabs.get(tabId);
  if (!entry) throw new Error("Not observing: call page.notifications.start() first");
  if (action === "list") return entry.ring.list(readFilter(options), Number(options.limit) || 200);
  if (action === "badge") return { badge: entry.badge, unread: entry.unread };
  throw new Error("UNSUPPORTED: page.notifications." + action);
}

/** Exported for tests: a tab created without Chrome (no CDP). */
export function pushTabForTest(tabId: number): void {
  tabs.set(tabId, { ring: new Ring(), tap: "", badge: null, unread: null });
}

function forget(tabId: number): void {
  tabs.get(tabId)?.ring.close();
  tabs.delete(tabId);
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== undefined && tabs.has(source.tabId) && !source.sessionId)
      pushDebuggerEvent(source.tabId, method, (params ?? {}) as Params);
  });
  chrome.tabs.onRemoved.addListener(forget);
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) forget(source.tabId);
  });
});
