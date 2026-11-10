import { send } from "./cdp/send.js";
import {
  reissueFilename,
  shouldReissueDownload,
  type DownloadAttempt,
} from "./evidence/download-reissue.js";
import { onEngineInstall } from "./native-engine-install.js";
import {
  holdDownloadReissue,
  onBeforeReceiptQuiet,
  receiptReissueState,
  releaseDownloadReissue,
  rememberReissuedName,
} from "./native-browser-receipts.js";
import { onBrowserDebuggerAttached } from "./native-browser-session.js";
import { noteInjectedScript } from "./stealth.js";

// Records a download navigate on the page. Chrome still performs the download; if the
// first one in the document is dropped before the request, the receipt reissues it.
const HOOK = `(() => {
  if (window.__aeonDownloadHook) return;
  window.__aeonDownloadHook = true;
  const nav = window.navigation;
  if (!nav || !nav.addEventListener) return;
  nav.addEventListener("navigate", (event) => {
    if (event.downloadRequest == null) return;
    const href = event.destination && event.destination.url;
    if (!href) return;
    window.__aeonDlAttempt = { href: String(href), name: String(event.downloadRequest), t: Date.now() };
  });
})()`;

const READ_ATTEMPT = `(() => {
  const attempt = window.__aeonDlAttempt;
  if (!attempt || typeof attempt.href !== "string") return null;
  return { href: attempt.href, name: String(attempt.name || ""), t: Number(attempt.t) || 0 };
})()`;

const RELEASE_MS = 2_000;

onBeforeReceiptQuiet((actionId) => reissueDroppedDownload(actionId));

onEngineInstall(() => {
  onBrowserDebuggerAttached((tabId) => installDownloadHook(tabId));
});

async function reissueDroppedDownload(actionId: string): Promise<void> {
  const attempt = await attemptFor(actionId);
  if (!attempt) return;
  const filename = reissueFilename(attempt.name);
  holdDownloadReissue(actionId);
  if (filename) rememberReissuedName(attempt.href, filename);
  // The download event releases the hold. This bound covers a reissue that never starts.
  setTimeout(() => releaseDownloadReissue(actionId), RELEASE_MS);
  try {
    const started = await startBrowserDownload(attempt.href, filename);
    if (!started) releaseDownloadReissue(actionId);
  } catch {
    releaseDownloadReissue(actionId);
  }
}

async function attemptFor(actionId: string): Promise<DownloadAttempt | undefined> {
  const before = receiptReissueState(actionId);
  if (!before || before.hasDownload) return undefined;
  const attempt = await readAttempt(before.tabId);
  const after = receiptReissueState(actionId);
  if (!after || after.hasDownload) return undefined;
  return shouldReissueDownload(attempt, after, Date.now());
}

// The hook lives in its own isolated world: the page shares the Navigation object's events
// but never sees the hook's globals. Chrome reuses an isolated world by name per frame.
const WORLD = "browserkit-downloads";

async function hookContext(tabId: number): Promise<number | undefined> {
  const tree = (await send(
    { tabId },
    "Page.getFrameTree",
    {},
    { label: "downloadHookFrame" },
  ).catch(() => undefined)) as { frameTree?: { frame?: { id?: string } } } | undefined;
  const frameId = tree?.frameTree?.frame?.id;
  if (!frameId) return undefined;
  const world = (await send(
    { tabId },
    "Page.createIsolatedWorld",
    { frameId, worldName: WORLD },
    { label: "downloadHookWorld" },
  ).catch(() => undefined)) as { executionContextId?: number } | undefined;
  return world?.executionContextId;
}

async function readAttempt(tabId: number): Promise<DownloadAttempt | undefined> {
  const contextId = await hookContext(tabId);
  if (contextId === undefined) return undefined;
  const result = (await send(
    { tabId },
    "Runtime.evaluate",
    { expression: READ_ATTEMPT, contextId, returnByValue: true },
    { label: "readDownloadAttempt", ms: 2_000 },
  ).catch(() => undefined)) as
    { result?: { value?: { href?: string; name?: string; t?: number } | null } } | undefined;
  const value = result?.result?.value;
  if (!value?.href) return undefined;
  return { href: String(value.href), name: String(value.name ?? ""), at: Number(value.t) || 0 };
}

function startBrowserDownload(url: string, filename?: string): Promise<boolean> {
  return requestDownload(url, filename).then((ok) => (ok || !filename ? ok : requestDownload(url)));
}

function requestDownload(url: string, filename?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!chrome.downloads?.download) {
      resolve(false);
      return;
    }
    chrome.downloads.download(
      { url, conflictAction: "uniquify", saveAs: false, ...(filename ? { filename } : {}) },
      () => resolve(!chrome.runtime.lastError),
    );
  });
}

async function installDownloadHook(tabId: number): Promise<void> {
  noteInjectedScript(tabId, "first download: reissue when Chrome drops it (isolated world)");
  await send(
    { tabId },
    "Page.addScriptToEvaluateOnNewDocument",
    { source: HOOK, worldName: WORLD },
    { label: "installDownloadHook" },
  ).catch(() => undefined);
  const contextId = await hookContext(tabId);
  if (contextId === undefined) return;
  await send(
    { tabId },
    "Runtime.evaluate",
    { expression: HOOK, contextId },
    { label: "installDownloadHook", ms: 2_000 },
  ).catch(() => undefined);
}
