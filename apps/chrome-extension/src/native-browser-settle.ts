interface Activity {
  pending: Map<string, number>;
  last: number;
}
export interface PageProbe {
  ready: string;
  idle: number;
  url: string;
  document: string;
  changes: number;
}
export interface PageSettle {
  why: "quiet" | "cap" | "error";
  ms: number;
  pending: number;
  probe?: PageProbe;
}
const activity = new Map<number, Activity>();
export function trackBrowserActivity(tabId: number): void {
  activity.set(tabId, { pending: new Map(), last: 0 });
}
export function forgetBrowserActivity(tabId: number): void {
  activity.delete(tabId);
}
chrome.debugger.onEvent.addListener((source, method, raw) => {
  if (source.tabId === undefined) return;
  const state = activity.get(source.tabId);
  if (!state) return;
  const data = (raw ?? {}) as { requestId?: string; type?: string; defaultPrompt?: string };
  if (method === "Page.javascriptDialogOpening")
    void chrome.debugger
      .sendCommand(source, "Page.handleJavaScriptDialog", {
        accept: true,
        promptText: data.defaultPrompt ?? "",
      })
      .catch(() => undefined);
  captureNetworkActivity(state, (source.sessionId ?? "") + ":" + data.requestId, method, data.type);
});
function captureNetworkActivity(state: Activity, key: string, method: string, type?: string) {
  if (method === "Network.requestWillBeSent") {
    if (["WebSocket", "EventSource", "Media", "Ping", "Manifest"].includes(type ?? "")) return;
    state.pending.set(key, Date.now());
    if (state.pending.size > 1000) state.pending.delete(state.pending.keys().next().value ?? "");
    state.last = Date.now();
  } else if (
    ["Network.loadingFinished", "Network.loadingFailed"].includes(method) &&
    state.pending.delete(key)
  )
    state.last = Date.now();
}
export function primeBrowserSettle(
  debuggee: chrome.debugger.Debuggee,
): Promise<PageProbe | undefined> {
  return probe(debuggee).catch(() => undefined);
}
function networkState(tabId: number) {
  const net = activity.get(tabId);
  return {
    pending: [...(net?.pending.values() ?? [])].filter((at) => Date.now() - at < 1500).length,
    quiet: Date.now() - (net?.last ?? 0) >= 80,
  };
}
export async function settleBrowserPage(
  debuggee: chrome.debugger.Debuggee,
  capMs = 800,
  since = Date.now(),
): Promise<PageSettle> {
  const start = Date.now();
  let limit = capMs,
    pending = 0,
    state: PageProbe | undefined;
  while (Date.now() - start < limit) {
    try {
      state = await probe(debuggee);
      if (state?.ready === "loading") limit = Math.max(capMs, 3000);
      const net = networkState(debuggee.tabId ?? -1);
      pending = net.pending;
      if (isQuiet(state, net, since))
        return { why: "quiet", ms: Date.now() - start, pending, probe: state };
    } catch (error) {
      if (!/context|navigat|frame/i.test(String(error)))
        return { why: "error", ms: Date.now() - start, pending };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { why: "cap", ms: Date.now() - start, pending, ...(state ? { probe: state } : {}) };
}
function isQuiet(
  state: PageProbe | undefined,
  net: { pending: number; quiet: boolean },
  since: number,
): state is PageProbe {
  return (
    !!state &&
    state.ready !== "loading" &&
    Math.min(state.idle, Date.now() - since) >= 80 &&
    !net.pending &&
    net.quiet
  );
}
export function pageOutcome(
  before: PageProbe | undefined,
  after: PageProbe | undefined,
): "navigated" | "changed" | "unchanged" | "unknown" {
  if (!before || !after) return "unknown";
  if (before.document !== after.document || before.url !== after.url) return "navigated";
  return before.changes !== after.changes ? "changed" : "unchanged";
}
async function probe(debuggee: chrome.debugger.Debuggee): Promise<PageProbe | undefined> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${domQuietProbe.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: PageProbe }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error("Execution context changed");
  return result.result?.value;
}
function domQuietProbe() {
  const host = window as unknown as {
    __aeonQuiet?: { last: number; changes: number; document: string; observer: MutationObserver };
  };
  if (!host.__aeonQuiet) {
    const state = {
      last: performance.now(),
      changes: 0,
      document: Math.random().toString(36),
      observer: undefined as unknown as MutationObserver,
    };
    const styles = new WeakMap<Node, number>();
    state.observer = new MutationObserver((records) => {
      const now = performance.now();
      for (const record of records) {
        if (ownOverlay(record)) continue;
        if (unchangedAttribute(record)) continue;
        if (record.attributeName === "style") {
          const previous = styles.get(record.target) ?? -Infinity;
          styles.set(record.target, now);
          if (now - previous < 200) continue;
        }
        state.last = now;
        state.changes++;
      }
    });
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
    });
    const changed = () => {
      state.last = performance.now();
      state.changes++;
    };
    document.addEventListener("input", changed, true);
    document.addEventListener("change", changed, true);
    host.__aeonQuiet = state;
  }
  return {
    ready: document.readyState,
    idle: performance.now() - host.__aeonQuiet.last,
    url: location.href,
    document: host.__aeonQuiet.document,
    changes: host.__aeonQuiet.changes,
  };
  function ownOverlay(record: MutationRecord) {
    return !!(record.target as Element).closest?.("[data-aeon-overlay]");
  }
  function unchangedAttribute(record: MutationRecord) {
    return (
      !!record.attributeName &&
      record.oldValue === (record.target as Element).getAttribute(record.attributeName)
    );
  }
}
