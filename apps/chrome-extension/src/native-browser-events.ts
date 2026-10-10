import type { BrowserExecutorRequest, BrowserTargetKey } from "@pippin/protocol";
interface EventItem {
  method: string;
  params: Record<string, unknown>;
  at: number;
  tabId: number;
}
interface Subscription {
  chatId: string;
  target: BrowserTargetKey;
  event: string;
  sessionId?: string;
  expires: number;
  queue: EventItem[];
  dropped: number;
  wake?: (() => void) | undefined;
  error?: string;
}
const subscriptions = new Map<string, Subscription>();
export function publishBrowserEvent(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): void {
  for (const [id, entry] of subscriptions) {
    if (entry.expires < Date.now()) {
      subscriptions.delete(id);
      entry.error = "Subscription expired";
      entry.wake?.();
      continue;
    }
    if (entry.target.tabId !== tabId || entry.event !== method || entry.sessionId !== sessionId)
      continue;
    const encoded = JSON.stringify(params);
    if (encoded.length > 16000) {
      entry.dropped++;
      continue;
    }
    entry.queue.push({ method, params, at: Date.now(), tabId });
    if (entry.queue.length > 16) {
      entry.queue.shift();
      entry.dropped++;
    }
    entry.wake?.();
  }
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined)
    publishBrowserEvent(
      source.tabId,
      method,
      (params ?? {}) as Record<string, unknown>,
      source.sessionId,
    );
});
chrome.tabs.onRemoved.addListener((tabId) => invalidateBrowserEvents(tabId, "Tab closed"));
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined)
    invalidateBrowserEvents(source.tabId, "Browser transport detached");
});
export function invalidateBrowserEvents(tabId: number, reason: string): void {
  for (const entry of subscriptions.values())
    if (entry.target.tabId === tabId) {
      entry.error = reason;
      entry.wake?.();
    }
}
export function releaseBrowserEvents(chatId?: string): void {
  for (const [id, entry] of subscriptions)
    if (!chatId || entry.chatId === chatId) {
      entry.error = "Browser workflow released";
      entry.wake?.();
      subscriptions.delete(id);
    }
}
type EventRequest = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "event" }>;
};
export async function executeBrowserEvent(
  request: EventRequest,
  debuggee: chrome.debugger.Debuggee & { sessionId?: string },
): Promise<unknown> {
  const step = request.step;
  if (step.action === "subscribe") return subscribe(request, debuggee);
  const id = step.subscriptionId ?? "",
    entry = subscriptions.get(id);
  assertSubscription(entry, request);
  if (step.action === "dispose") {
    subscriptions.delete(id);
    entry.error = "Subscription disposed";
    entry.wake?.();
    if (shouldReleaseChooser(entry))
      await chrome.debugger
        .sendCommand(
          { ...debuggee, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) },
          "Page.setInterceptFileChooserDialog",
          { enabled: false },
        )
        .catch(() => undefined);
    return { disposed: true };
  }
  if (!entry.queue.length && !entry.error && step.timeoutMs)
    await waitForEvent(entry, step.timeoutMs);
  if (entry.error) throw new Error(entry.error);
  if (entry.expires < Date.now())
    throw new Error("Event subscription expired; register a new listener");
  entry.expires = Date.now() + 60000;
  return { events: drainEvents(entry), dropped: entry.dropped };
}
function shouldReleaseChooser(entry: Subscription): boolean {
  return (
    entry.event === "Page.fileChooserOpened" &&
    ![...subscriptions.values()].some(
      (other) =>
        other.event === entry.event &&
        other.target.tabId === entry.target.tabId &&
        other.sessionId === entry.sessionId,
    )
  );
}
function waitForEvent(entry: Subscription, timeout: number): Promise<void> {
  if (entry.wake) throw new Error("A subscription already has a waiting consumer");
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      entry.wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    entry.wake = finish;
  });
}

async function subscribe(
  request: EventRequest,
  debuggee: chrome.debugger.Debuggee & { sessionId?: string },
): Promise<unknown> {
  const step = request.step;
  for (const [id, entry] of subscriptions)
    if (entry.expires < Date.now()) {
      entry.error = "Subscription expired";
      entry.wake?.();
      subscriptions.delete(id);
    }

  if (!step.event || !/^(Page|Network|Runtime|DOM)\.[A-Za-z]+$|^(popup|download)$/.test(step.event))
    throw new Error("UNSUPPORTED");
  if (subscriptions.size >= 128)
    throw new Error("Too many browser subscriptions; dispose unused listeners");
  const domain = step.event.split(".")[0];
  if (!["popup", "download"].includes(domain ?? ""))
    await chrome.debugger.sendCommand(debuggee, domain + ".enable");
  if (step.event === "Page.fileChooserOpened")
    await chrome.debugger.sendCommand(debuggee, "Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
  const subscriptionId = crypto.randomUUID();
  subscriptions.set(subscriptionId, {
    chatId: request.chatId,
    target: step.target,
    event: step.event,
    ...(debuggee.sessionId ? { sessionId: debuggee.sessionId } : {}),
    expires: Date.now() + 60000,
    queue: [],
    dropped: 0,
  });
  return { subscriptionId, registered: true };
}

function assertSubscription(
  entry: Subscription | undefined,
  request: EventRequest,
): asserts entry is Subscription {
  if (
    !entry ||
    entry.chatId !== request.chatId ||
    JSON.stringify(entry.target) !== JSON.stringify(request.step.target)
  )
    throw new Error("INVALID_TARGET");
}
function drainEvents(entry: Subscription): EventItem[] {
  const result: EventItem[] = [];
  let size = 0;
  while (entry.queue.length && size < 100000) {
    const item = entry.queue.shift();
    if (!item) break;
    size += JSON.stringify(item).length;
    result.push(item);
  }
  return result;
}
