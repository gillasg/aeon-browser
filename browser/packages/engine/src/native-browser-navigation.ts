import { noteDeviceEmulation, withFocusEmulation } from "./native-browser-session.js";
export { viewportFingerprint } from "./native-browser-viewport-print.js";
import {
  hintEvaluateError,
  pageExceptionCode,
  policyBlockedError,
  stillLoading,
  waitForIdleUntil,
  type IdleResult,
} from "./native-browser-load-result.js";
export {
  hintEvaluateError,
  pageExceptionCode,
  policyBlockedError,
  stillLoading,
  waitForIdleUntil,
  type IdleResult,
};
import { chromeNetErrorCode, type BrowserExecutorRequest } from "@browserkit/protocol";
import { BrowserActionError } from "./native-browser-common.js";
import { withContextRetry } from "./cdp/context-retry.js";
import { callClass, send } from "./cdp/send.js";
import { refusedCdp } from "./native-browser-guards.js";
import { onEngineInstall } from "./native-engine-install.js";
import { noteInjectedScript } from "./stealth.js";

interface Activity {
  pending: Map<string, number>;
  /** The URL of each pending request, by the same key. */
  urls: Map<string, string>;
  last: number;
  navigating?: number;
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
  /** A network request finished after this settle window started. */
  network?: boolean;
  probe?: PageProbe;
}
const activity = new Map<number, Activity>();
export function trackBrowserActivity(tabId: number): void {
  activity.set(tabId, { pending: new Map(), urls: new Map(), last: 0 });
}
export function forgetBrowserActivity(tabId: number): void {
  activity.delete(tabId);
}
onEngineInstall(() => {
  const nav = (tabId: number, on: boolean) => {
    const s = activity.get(tabId);
    if (s) s.navigating = on ? Date.now() : 0;
  };
  chrome.webNavigation?.onBeforeNavigate?.addListener((e) => e.frameId === 0 && nav(e.tabId, true));
  for (const ev of [
    chrome.webNavigation?.onDOMContentLoaded,
    chrome.webNavigation?.onCompleted,
    chrome.webNavigation?.onErrorOccurred,
  ])
    ev?.addListener((e) => e.frameId === 0 && nav(e.tabId, false));
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    const state = source.tabId !== undefined ? activity.get(source.tabId) : undefined;
    if (!state) return;
    if (!source.sessionId && /^Page\.frame(?:RequestedNavigation|StartedLoading)$/.test(method))
      state.navigating = Date.now();
    else if (!source.sessionId && /^Page\.(?:frameStoppedLoading|loadEventFired)$/.test(method))
      state.navigating = 0;
    const data = (raw ?? {}) as { requestId?: string; type?: string; request?: { url?: string } };
    captureNetworkActivity(
      state,
      `${source.sessionId ?? ""}:${data.requestId}`,
      method,
      data.type,
      data.request?.url,
    );
  });
});
function captureNetworkActivity(
  state: Activity,
  key: string,
  method: string,
  type?: string,
  url?: string,
) {
  if (method === "Network.requestWillBeSent") {
    if (["WebSocket", "EventSource", "Media", "Ping", "Manifest"].includes(type ?? "")) return;
    state.pending.set(key, Date.now());
    if (url) state.urls.set(key, url);
    if (state.pending.size > 1000) {
      const oldest = state.pending.keys().next().value ?? "";
      state.pending.delete(oldest);
      state.urls.delete(oldest);
    }
    state.last = Date.now();
  } else if (
    ["Network.loadingFinished", "Network.loadingFailed"].includes(method) &&
    state.pending.delete(key)
  ) {
    state.urls.delete(key);
    state.last = Date.now();
  }
}

/** Requests still open on a tab, oldest first, for a bounded "still loading" result. */
export function pendingRequests(
  tabId: number,
  now = Date.now(),
): Array<{ url: string; ageMs: number }> {
  const net = activity.get(tabId);
  if (!net) return [];
  return [...net.pending.entries()]
    .map(([key, at]) => ({ url: net.urls.get(key) ?? "", ageMs: Math.max(0, now - at) }))
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, 10);
}

export function primeBrowserSettle(
  debuggee: chrome.debugger.Debuggee,
): Promise<PageProbe | undefined> {
  return probe(debuggee).catch(() => undefined);
}
function networkState(tabId: number, since = 0) {
  const net = activity.get(tabId);
  return {
    pending: [...(net?.pending.values() ?? [])].filter((at) => Date.now() - at < 1500).length,
    quiet: Date.now() - (net?.last ?? 0) >= 80,
    active: (net?.last ?? 0) >= since,
    navigating: Boolean(net?.navigating && Date.now() - net.navigating < 3000),
  };
}

export async function settleBrowserPage(
  debuggee: chrome.debugger.Debuggee,
  capMs = 800,
  since = Date.now(),
  minQuietMs = 80,
): Promise<PageSettle> {
  const start = Date.now();
  let limit = capMs,
    pending = 0,
    state: PageProbe | undefined;
  while (Date.now() - start < limit) {
    try {
      state = await probe(debuggee);
      const net = networkState(debuggee.tabId ?? -1, since);
      if (state?.ready === "loading" || net.navigating) limit = Math.max(capMs, 3000);
      pending = net.pending;
      if (isQuiet(state, net, since, minQuietMs))
        return {
          why: "quiet",
          ms: Date.now() - start,
          pending,
          network: net.active,
          probe: state,
        };
    } catch (error) {
      if (!/context|navigat|frame/i.test(String(error)))
        return { why: "error", ms: Date.now() - start, pending };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    why: "cap",
    ms: Date.now() - start,
    pending,
    network: networkState(debuggee.tabId ?? -1, since).active,
    ...(state ? { probe: state } : {}),
  };
}
function isQuiet(
  state: PageProbe | undefined,
  net: { pending: number; quiet: boolean; navigating?: boolean },
  since: number,
  minQuietMs: number,
): state is PageProbe {
  return (
    !!state &&
    state.ready !== "loading" &&
    !net.navigating &&
    Math.min(state.idle, Date.now() - since) >= minQuietMs &&
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
function scriptMs(timeout: number): number {
  return timeout > 0 && Number.isFinite(timeout) ? timeout : 5_000;
}

function sendOpts(label: string, method: string, params: unknown): { label: string; ms?: number } {
  if (callClass(method) !== "eval") return { label };
  const timeout = (params as { timeout?: unknown } | undefined)?.timeout;
  return { label, ms: scriptMs(typeof timeout === "number" ? timeout : 0) };
}

// The settle probe keeps its observer in its own world, not the page's: the page cannot list a
// world it does not own, so no `__graft*` global (and no observer) shows up in a check. One world
// per document: a navigation drops the context and the next probe makes another.
const QUIET_WORLD = "browserkit-quiet";
interface QuietWorld {
  /** The main frame, which stays the same id across that tab's navigations. */
  frame?: string;
  context?: number;
  /** This document has no isolated world (chrome://, the Web Store): use the page's own. */
  pageWorld: boolean;
}
const quietWorlds = new Map<number, QuietWorld>();

function forgetQuietWorld(tabId: number): void {
  const state = quietWorlds.get(tabId);
  if (!state) return;
  delete state.context;
  state.pageWorld = false;
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Page.frameNavigated" || source.tabId === undefined) return;
    if ((params as { frame?: { parentId?: string } }).frame?.parentId) return;
    forgetQuietWorld(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => quietWorlds.delete(tabId));
});

async function mainFrame(
  debuggee: chrome.debugger.Debuggee,
  tabId: number,
  state: QuietWorld,
): Promise<string> {
  if (state.frame) return state.frame;
  const tree = (await send(debuggee, "Page.getFrameTree", {}, { label: "quietFrame" })) as
    { frameTree?: { frame?: { id?: string } } } | undefined;
  const frame = tree?.frameTree?.frame?.id;
  if (!frame) throw new Error("Execution context changed");
  state.frame = frame;
  quietWorlds.set(tabId, state);
  return frame;
}

async function quietContext(debuggee: chrome.debugger.Debuggee): Promise<number | undefined> {
  const tabId = debuggee.tabId;
  if (tabId === undefined) return undefined;
  const state = quietWorlds.get(tabId) ?? { pageWorld: false };
  if (state.pageWorld) return undefined;
  if (state.context !== undefined) return state.context;
  const frameId = await mainFrame(debuggee, tabId, state);
  // A frame mid-commit refuses the world once; the next probe (20 ms later) gets one. Two tries
  // tell "not ready yet" from "this scheme has no isolated worlds" without leaking into the page.
  for (let attempt = 0; attempt < 2; attempt++) {
    const made = (await send(
      debuggee,
      "Page.createIsolatedWorld",
      { frameId, worldName: QUIET_WORLD },
      { label: "quietWorld" },
    ).catch(() => undefined)) as { executionContextId?: number } | undefined;
    const context = made?.executionContextId;
    if (context !== undefined) {
      state.context = context;
      quietWorlds.set(tabId, state);
      noteInjectedScript(tabId, "the settle probe (isolated world)", "isolated");
      return context;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  state.pageWorld = true;
  quietWorlds.set(tabId, state);
  noteInjectedScript(
    tabId,
    "the settle probe (page world: no isolated world on this page)",
    "main",
  );
  return undefined;
}

async function probe(debuggee: chrome.debugger.Debuggee): Promise<PageProbe | undefined> {
  // The settle probe lives in a cached isolated world that a navigation drops. Forget it and
  // make another, a couple of times, before the settle loop sees a failure.
  return withContextRetry(() => probeOnce(debuggee), {
    invalidate: () => {
      if (debuggee.tabId !== undefined) forgetQuietWorld(debuggee.tabId);
    },
  });
}

async function probeOnce(debuggee: chrome.debugger.Debuggee): Promise<PageProbe | undefined> {
  const contextId = await quietContext(debuggee);
  const result = (await send(
    debuggee,
    "Runtime.evaluate",
    {
      expression: `(${domQuietProbe.toString()})()`,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    },
    { label: "probe", ms: 5_000 },
  ).catch((error: unknown) => {
    if (debuggee.tabId !== undefined) forgetQuietWorld(debuggee.tabId);
    throw error;
  })) as { result?: { value?: PageProbe }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error("Execution context changed");
  return result.result?.value;
}
function domQuietProbe() {
  // Runs in the tab's own isolated world (or, on a page that has none, its own window). The
  // observer and its state never touch the page's globals in the normal case.
  // Graft's own layers (labels, annotations, the agent cursor) are not the page changing.
  const OVERLAY = "[data-ux-overlay],[data-uxb-overlay]";
  const host = window as unknown as {
    __uxQuiet?: { last: number; changes: number; document: string; observer: MutationObserver };
  };
  if (!host.__uxQuiet) {
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
        if (overlayNode(record)) continue;
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
    // A text field's change fires late, when focus leaves it: that is the earlier typing
    // committing, not the click that moved focus doing anything.
    document.addEventListener(
      "change",
      (event) => {
        if (event.target === document.activeElement || !blurCommit(event.target)) changed();
      },
      true,
    );
    host.__uxQuiet = state;
  }
  return {
    ready: document.readyState,
    idle: performance.now() - host.__uxQuiet.last,
    url: location.href,
    document: host.__uxQuiet.document,
    changes: host.__uxQuiet.changes,
  };
  function blurCommit(target: EventTarget | null) {
    return (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        !["checkbox", "radio", "file", "range", "color"].includes(target.type))
    );
  }
  function ownOverlay(record: MutationRecord) {
    return !!(record.target as Element).closest?.(OVERLAY) || stealthHost(record.target);
  }
  function overlayNode(record: MutationRecord) {
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (stealthHost(node)) return true;
      if (node instanceof Element && (node.matches(OVERLAY) || node.closest(OVERLAY))) return true;
    }
    return false;
  }
  // The cursor and its controls mount unmarked hosts (a page must not find them): an empty div
  // whose only attribute is a full-viewport, click-through, topmost style. Its content lives in a
  // closed shadow root, so to this world it has no children and no shadowRoot.
  function stealthHost(node: Node) {
    if (!(node instanceof HTMLDivElement)) return false;
    if (node.attributes.length !== 1 || node.childNodes.length || node.shadowRoot) return false;
    const style = node.style;
    return (
      style.position === "fixed" &&
      style.zIndex === "2147483647" &&
      style.pointerEvents === "none" &&
      ["top", "right", "bottom", "left"].every((side) => style.getPropertyValue(side) === "0px")
    );
  }
  function unchangedAttribute(record: MutationRecord) {
    return (
      !!record.attributeName &&
      record.oldValue === (record.target as Element).getAttribute(record.attributeName)
    );
  }
}

async function showingDocument(tabId: number, fallback: string): Promise<string> {
  const live = (await send(
    { tabId },
    "Runtime.evaluate",
    { expression: "location.href", returnByValue: true },
    { label: "stopPendingNavigation", ms: 500 },
  ).catch(() => undefined)) as { result?: { value?: string } } | undefined;
  if (typeof live?.result?.value === "string" && live.result.value) return live.result.value;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return tab?.url || fallback;
}

// A navigation that never committed is stopped, so the tab does not stay on a dead load.
// The call still resolves: timedOut is a result, and note names the document that remains.
async function navigationTimedOut(
  tabId: number,
  requested: string,
  committed: boolean,
): Promise<{ url: string; note?: string }> {
  if (committed) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    return { url: tab?.url ?? requested };
  }
  await send({ tabId }, "Page.stopLoading", {}, { label: "stopPendingNavigation", ms: 500 }).catch(
    () => undefined,
  );
  const showing = await showingDocument(tabId, requested);
  return { url: showing, note: `still showing ${showing}; retry with a longer timeout` };
}

export async function waitPageInteractive(tabId: number, timeoutMs = 2000): Promise<boolean> {
  return (await settleBrowserPage({ tabId }, timeoutMs)).why === "quiet";
}

/** True when the DOM or the network moved since the last sample. The first sample is the baseline. */
export async function pageStillChanging(
  debuggee: chrome.debugger.Debuggee,
  seen: number | undefined,
): Promise<{ active: boolean; changes: number | undefined }> {
  const state = await primeBrowserSettle(debuggee).catch(() => undefined);
  const changes = state?.changes;
  const net = networkState(debuggee.tabId ?? -1, Date.now() - 500);
  const moved = seen !== undefined && changes !== undefined && changes !== seen;
  return { active: moved || net.pending > 0 || net.active, changes };
}

const INTERIM_PAGE = /^(chrome-extension|chrome|edge|about|chrome-search|chrome-untrusted):/i;

// Resolves once the tab has committed to the requested page and reached DOMContentLoaded.
export async function navigateReady(
  tabId: number,
  url: string,
  timeoutMs = 8000,
  referer?: string,
  reload = false,
): Promise<{ url: string; timedOut: boolean; note?: string } & IdleResult> {
  const deadline = Date.now() + timeoutMs;
  const navigation = await new Promise<{ url: string; timedOut: boolean; note?: string }>(
    (resolve, reject) => {
      let committed = false;
      const top = (event: { tabId: number; frameId: number }) =>
        event.tabId === tabId && event.frameId === 0;
      const clean = () => {
        clearTimeout(timer);
        chrome.webNavigation.onCommitted.removeListener(commit);
        chrome.webNavigation.onDOMContentLoaded.removeListener(ready);
        chrome.webNavigation.onErrorOccurred.removeListener(error);
        chrome.webNavigation.onHistoryStateUpdated.removeListener(sameDocument);
        chrome.webNavigation.onReferenceFragmentUpdated.removeListener(sameDocument);
      };
      const finish = (nextUrl: string, timedOut = false) => {
        clean();
        resolve({ url: nextUrl, timedOut });
      };
      // A new-tab, extension or blank page committed on the way is not the requested page.
      const interim = (eventUrl: string) => INTERIM_PAGE.test(eventUrl) && !INTERIM_PAGE.test(url);
      const commit = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
        if (top(event) && !interim(event.url)) committed = true;
      };
      const ready = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
        if (top(event) && committed && !interim(event.url)) finish(event.url);
      };
      const sameDocument = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
        if (top(event) && !interim(event.url)) finish(event.url);
      };
      const error = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
        if (top(event) && !event.error.includes("ERR_ABORTED")) {
          clean();
          reject(
            policyBlockedError(event.error, event.url || url) ??
              new BrowserActionError(
                chromeNetErrorCode(event.error) ?? "CHROME_ERROR",
                "navigation failed: " + event.error,
              ),
          );
        }
      };
      const timer = setTimeout(
        () => {
          const wasCommitted = committed;
          clean();
          void navigationTimedOut(tabId, url, wasCommitted).then(
            (shown) =>
              resolve({
                url: shown.url,
                timedOut: true,
                ...(shown.note ? { note: shown.note } : {}),
              }),
            reject,
          );
        },
        Math.max(100, timeoutMs - Math.min(2000, Math.floor(timeoutMs * 0.25))),
      );
      chrome.webNavigation.onCommitted.addListener(commit);
      chrome.webNavigation.onDOMContentLoaded.addListener(ready);
      chrome.webNavigation.onErrorOccurred.addListener(error);
      chrome.webNavigation.onHistoryStateUpdated.addListener(sameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated.addListener(sameDocument);
      const navigate = reload
        ? send({ tabId }, "Page.reload", {}, { label: "reloadReady" })
        : referer
          ? send({ tabId }, "Page.navigate", { url, referrer: referer }, { label: "navigateReady" })
          : chrome.tabs.update(tabId, { url });
      void navigate.catch((cause) => {
        clean();
        reject(cause);
      });
    },
  );
  const idle = navigation.timedOut
    ? stillLoading(pendingRequests(tabId))
    : await waitForIdleUntil(tabId, deadline);
  const note = [navigation.note, idle.note].filter(Boolean).join("; ");
  return { ...navigation, ...idle, ...(note ? { note } : {}) };
}

// Only commands that can change what the page shows wait for it to settle. Getters, captures,
// emulation, screencasts and pointer moves return at once, so fine-grained input stays fast.
const SETTLING_CDP =
  /^(Input\.(dispatchKeyEvent|insertText|dispatchTouchEvent)|Page\.(navigate|reload|navigateToHistoryEntry)|Runtime\.(evaluate|callFunctionOn)|DOM\.(set|remove|focus))/;
function cdpChangesPage(method: string, params: unknown): boolean {
  if (method === "Input.dispatchMouseEvent")
    return (params as { type?: string } | undefined)?.type === "mouseReleased";
  return SETTLING_CDP.test(method);
}
type Request = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "evaluate" | "cdp" | "waitFor" }>;
};
export async function executePageCode(
  debuggee: chrome.debugger.Debuggee,
  request: Request,
  revalidate: () => Promise<void>,
): Promise<unknown> {
  const step = request.step;
  if (step.op === "waitFor") {
    const start = Date.now();
    while (Date.now() - start < step.timeoutMs) {
      await revalidate();
      const value = await evaluatePage(
        debuggee,
        step.expression,
        Math.max(1, step.timeoutMs - (Date.now() - start)),
      );
      if (value) return { found: true, ms: Date.now() - start };
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new BrowserActionError(
      "TIMEOUT",
      "Page condition did not become true. Inspect the current state before proceeding.",
    );
  }
  const readOnly = step.op === "cdp" && !cdpChangesPage(step.method, step.params);
  if (!readOnly) await primeBrowserSettle(debuggee);
  let value: unknown;
  if (step.op === "evaluate")
    return answeredWithin(EVALUATE_WALL_MS, evaluateStep(debuggee, step.expression));
  else {
    // This command operates on the claimed page session, never on a browser-wide or another target session.
    if (["Target", "Browser"].includes(step.method.split(".")[0] ?? ""))
      throw new BrowserActionError(
        "UNSUPPORTED",
        "Use browser.openTab/attachTab for target management; page.cdp addresses the selected page only.",
      );
    const refused = refusedCdp(step.method, step.params as Record<string, unknown>);
    if (refused) throw new BrowserActionError("UNSUPPORTED", refused);
    const issue = () =>
      send(
        debuggee,
        step.method,
        step.params,
        sendOpts("executePageCode", step.method, step.params),
      );
    // A synthetic mouse move or press through page.cdp needs the tab focus-emulated too: after a
    // click turned it off, macOS Chrome leaves the next Input.dispatchMouseEvent unanswered.
    value =
      step.method === "Input.dispatchMouseEvent"
        ? await withFocusEmulation(debuggee.tabId, issue)
        : await issue();
    if (debuggee.tabId !== undefined) noteDeviceEmulation(debuggee.tabId, step.method, step.params);
  }
  return {
    value,
    ...(!readOnly ? { settle: await settleBrowserPage(debuggee, 800, Date.now(), 0) } : {}),
  };
}
async function evaluateStep(debuggee: chrome.debugger.Debuggee, expression: string) {
  const before = await pageFingerprint(debuggee);
  const value = await evaluatePage(debuggee, expression, 8000);
  const settle = await settleBrowserPage(debuggee, 800, Date.now(), 0);
  // A read that left the page as it was needs no fresh observation afterwards.
  const changed = before === undefined || before !== (await pageFingerprint(debuggee));
  return { value, settle, changed };
}

// Chrome can leave a command to a page unanswered (a busy or paused renderer): without a wall-clock
// bound the step waits until its whole cell dies. 8 s of script time plus settling fits inside this.
const EVALUATE_WALL_MS = 15_000;
async function answeredWithin<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserActionError(
                "TIMEOUT",
                `The page did not answer within ${ms / 1000} s (a busy page, or a background tab Chrome paused); the cell is still running: try the read again.`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// URL, element count and text length: cheap, and enough to tell a read from a change.
// A hung renderer must not stall the step: give up and report unknown.
const FINGERPRINT_MS = 1_500;
const FINGERPRINT_EXPRESSION =
  "location.href+'|'+document.getElementsByTagName('*').length+'|'+(document.body?document.body.textContent.length:0)";

export async function pageFingerprint(
  debuggee: chrome.debugger.Debuggee,
  timeoutMs = FINGERPRINT_MS,
): Promise<string | undefined> {
  const value = await fingerprintWithin(debuggee, timeoutMs);
  return typeof value === "string" ? value : undefined;
}

async function fingerprintWithin(
  debuggee: chrome.debugger.Debuggee,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  try {
    return await Promise.race([
      readFingerprint(debuggee, timeoutMs),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          late = true;
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (late) await stopFingerprint(debuggee);
  }
}

async function readFingerprint(
  debuggee: chrome.debugger.Debuggee,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const ms = scriptMs(timeoutMs);
    const result = (await send(
      debuggee,
      "Runtime.evaluate",
      { expression: FINGERPRINT_EXPRESSION, returnByValue: true, timeout: ms },
      { label: "readFingerprint", ms },
    )) as { result?: { value?: unknown } } | undefined;
    return result?.result?.value;
  } catch {
    return undefined;
  }
}

async function stopFingerprint(debuggee: chrome.debugger.Debuggee): Promise<void> {
  await Promise.race([
    send(debuggee, "Runtime.terminateExecution", {}, { label: "stopFingerprint" }).catch(
      () => undefined,
    ),
    new Promise((resolve) => setTimeout(resolve, 200)),
  ]);
}

async function evaluatePage(
  debuggee: chrome.debugger.Debuggee,
  expression: string,
  timeout: number,
) {
  let result: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  try {
    const ms = scriptMs(timeout);
    result = (await send(
      debuggee,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, timeout: ms },
      { label: "evaluatePage", ms },
    )) as typeof result;
  } catch (error) {
    if (!isEvaluationTimeout(error instanceof Error ? error.message : String(error))) throw error;
    throw await evaluationTimeout(debuggee, timeout, String(error));
  }
  if (result.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Page evaluation failed";
    if (isEvaluationTimeout(detail)) throw await evaluationTimeout(debuggee, timeout, detail);
    throw new BrowserActionError(
      pageExceptionCode(detail),
      hintEvaluateError(detail).slice(0, 1800),
    );
  }
  return result.result?.value;
}

function isEvaluationTimeout(text: string): boolean {
  return /timed out|timeout|execution (?:was )?terminated|script execution|internal error/i.test(
    text,
  );
}

/**
 * A timeout is already enforced by Runtime.evaluate. Terminate explicitly too, then probe with a
 * trivial evaluation so a late terminate cannot cancel the next call; the probe also tells the
 * caller whether the runaway script actually stopped.
 */
async function evaluationTimeout(
  debuggee: chrome.debugger.Debuggee,
  timeout: number,
  detail: string,
): Promise<BrowserActionError> {
  let terminated = false;
  try {
    await send(debuggee, "Runtime.terminateExecution", {}, { label: "evaluationTimeout" });
    terminated = true;
  } catch {
    /* The execution may already be gone. */
  }
  let stopped = false;
  for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 80));
    stopped = await send(
      debuggee,
      "Runtime.evaluate",
      { expression: "1+1", returnByValue: true, timeout: 1000 },
      { label: "evaluationTimeout", ms: 1000 },
    ).then(
      (probe) => (probe as { result?: { value?: unknown } }).result?.value === 2,
      () => false,
    );
  }
  const flags = `{"executionStopped":${stopped && terminated},"mayHaveLateEffects":true}`;
  return new BrowserActionError(
    "TIMEOUT",
    `${detail.slice(0, 1200)}\nPage evaluation exceeded ${timeout}ms. ${flags}`,
  );
}
