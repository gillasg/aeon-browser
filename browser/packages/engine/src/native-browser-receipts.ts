import {
  closeWhenQuiet,
  createOpenReceipt,
  noteDialogClose,
  noteDialogOpen,
  noteDownload,
  noteNavigationDone,
  noteNavigationStart,
  noteRequestEnd,
  noteRequestStart,
  chooseReceipt,
  overlapText,
  settledRequests,
  type OpenReceipt,
  type TrackedRequest,
} from "./evidence/receipt.js";
import { onEngineInstall } from "./native-engine-install.js";

// One receipt per action: the dialog, download, navigation and document/fetch/XHR calls that
// action could have caused. A click with nothing in flight still closes at once.
export interface ActionReceipt {
  popups: { tabId: number; url: string }[];
  dialog?: { type: string; message: string; accepted: boolean };
  navigated: boolean;
  download?: { url: string; filename: string; token?: string };
  requests?: ReceiptRequest[];
  /** An earlier input on this tab timed out and may still land. */
  lateReply?: string;
  /** Still running when the cap closed the receipt, e.g. "request:/api/export". */
  open?: string[];
  /** A request was attributed here while another action on the tab was still open. */
  overlap?: string;
}
export interface ReceiptRequest {
  method: string;
  url: string;
  status?: number;
  error?: string;
}

const MAX_REQUESTS = 8;

interface LiveReceipt {
  open: OpenReceipt;
  body: ActionReceipt;
}

const lives = new Map<string, LiveReceipt>();
const byTab = new Map<number, string[]>();
const tabUrls = new Map<string, Promise<string | undefined>>();
const lookups = new Set<Promise<void>>();
const lateNotes = new Map<number, { detail: string; landed: boolean }>();
let actionSeq = 0;

/** An input-class send timed out. The next receipt on this tab says so. */
export function noteLateInput(tabId: number, detail: string): void {
  lateNotes.set(tabId, { detail: detail.slice(0, 180), landed: false });
}

/** The timed-out input's CDP call settled after the limit. */
export function noteLateInputLanded(tabId: number): void {
  const note = lateNotes.get(tabId);
  if (note) note.landed = true;
}

export function beginReceipt(tabId: number): string {
  const actionId = `a${++actionSeq}`;
  const lateReply = takeLateNote(tabId);
  const body: ActionReceipt = {
    popups: [],
    navigated: false,
    ...(lateReply ? { lateReply } : {}),
  };
  lives.set(actionId, { open: createOpenReceipt(actionId, tabId), body });
  const open = byTab.get(tabId) ?? [];
  open.push(actionId);
  byTab.set(tabId, open);
  tabUrls.set(
    actionId,
    chrome.tabs.get(tabId).then(
      (tab) => tab.url,
      () => undefined,
    ),
  );
  return actionId;
}

/** Waits until this action's caused work is quiet, then returns the receipt. */
export async function finishReceipt(actionId: string): Promise<ActionReceipt> {
  const live = lives.get(actionId);
  if (!live) return { popups: [], navigated: false };
  const closed = await closeWhenQuiet(live.open);
  await drainLookups();
  copyRequests(live);
  if (closed.open?.length) live.body.open = closed.open;
  const note = overlapText(opensOn(live.open.tabId), live.open);
  if (note) live.body.overlap = note;
  return detach(actionId) ?? live.body;
}

/** Drops an action's receipt when the action failed before it could close. */
export function dropReceipt(actionId: string): void {
  detach(actionId);
}

/** The latest receipt for a tab, without waiting. Tests and early readers use this. */
export function takeReceipt(tabId: number): ActionReceipt {
  const actionId = byTab.get(tabId)?.at(-1);
  if (!actionId) return { popups: [], navigated: false };
  const live = lives.get(actionId);
  if (live) copyRequests(live);
  return detach(actionId) ?? { popups: [], navigated: false };
}

/** The dialog policy records what it answered while this action's receipt is open. */
export function noteReceiptDialog(
  tabId: number,
  dialog: { type: string; message: string; accepted: boolean },
): void {
  const live = liveFor(tabId);
  if (!live) return;
  live.body.dialog = {
    type: dialog.type.slice(0, 40),
    message: dialog.message.slice(0, 300),
    accepted: dialog.accepted,
  };
  noteDialogOpen(live.open, Date.now());
}

export function noteReceiptPopup(openerId: number, tabId: number, url = ""): void {
  const live = liveFor(openerId);
  if (!live) return;
  live.body.popups.push({ tabId, url });
}

function liveFor(tabId: number, share = false): LiveReceipt | undefined {
  const chosen = chooseReceipt(opensOn(tabId), tabId, share);
  return chosen ? lives.get(chosen.actionId) : undefined;
}

function opensOn(tabId: number): OpenReceipt[] {
  return (byTab.get(tabId) ?? []).flatMap((id) => {
    const live = lives.get(id);
    return live ? [live.open] : [];
  });
}

function copyRequests(live: LiveReceipt): void {
  const requests = keptRequests(settledRequests(live.open));
  if (requests.length) live.body.requests = requests;
  else delete live.body.requests;
}

function detach(actionId: string): ActionReceipt | undefined {
  const live = lives.get(actionId);
  if (!live) return undefined;
  lives.delete(actionId);
  tabUrls.delete(actionId);
  const rest = (byTab.get(live.open.tabId) ?? []).filter((id) => id !== actionId);
  if (rest.length) byTab.set(live.open.tabId, rest);
  else byTab.delete(live.open.tabId);
  return live.body;
}

function takeLateNote(tabId: number): string | undefined {
  const note = lateNotes.get(tabId);
  if (!note) return undefined;
  lateNotes.delete(tabId);
  const text = note.landed ? `late reply landed: ${note.detail}` : `late reply: ${note.detail}`;
  return text.slice(0, 300);
}

function keptRequests(requests: TrackedRequest[]): ReceiptRequest[] {
  const failed = requests.filter((item) => item.error || (item.status ?? 0) >= 400);
  const rest = requests.filter((item) => !failed.includes(item));
  return [...failed, ...rest].slice(0, MAX_REQUESTS);
}

function onRequest(live: LiveReceipt, params: Record<string, unknown>): void {
  if (params.type !== "XHR" && params.type !== "Fetch" && params.type !== "Document") return;
  const request = (params.request ?? {}) as { method?: string; url?: string };
  noteRequestStart(live.open, {
    id: String(params.requestId ?? ""),
    method: String(request.method ?? "GET"),
    url: String(request.url ?? ""),
    at: Date.now(),
  });
}

function onResponse(live: LiveReceipt, params: Record<string, unknown>): void {
  const status = Number((params.response as { status?: number } | undefined)?.status ?? 0);
  noteRequestEnd(live.open, { id: String(params.requestId ?? ""), at: Date.now(), status });
}

function onFailed(live: LiveReceipt, params: Record<string, unknown>): void {
  noteRequestEnd(live.open, {
    id: String(params.requestId ?? ""),
    at: Date.now(),
    error: String(params.errorText ?? "failed"),
  });
}

function onDialogClosed(live: LiveReceipt, params: Record<string, unknown>): void {
  if (live.body.dialog) live.body.dialog.accepted = Boolean(params.result);
  noteDialogClose(live.open, Date.now());
}

function onDownload(live: LiveReceipt, params: Record<string, unknown>): void {
  if (live.body.download) return;
  live.body.download = {
    url: String(params.url ?? "").slice(0, 2000),
    filename: String(params.suggestedFilename ?? "").slice(0, 300),
    ...(params.guid ? { token: String(params.guid).slice(0, 200) } : {}),
  };
  noteDownload(live.open, Date.now());
}

function onFrame(live: LiveReceipt, params: Record<string, unknown>): void {
  const frame = params.frame as { parentId?: string; url?: string } | undefined;
  if (frame?.parentId) return;
  noteNavigationStart(live.open, Date.now());
  const next = String(frame?.url ?? "");
  const check = confirmNavigation(live, next).finally(() => lookups.delete(check));
  lookups.add(check);
}

/** A same-document frame event is not a navigation, so it must not hold the receipt for 15s. */
async function confirmNavigation(live: LiveReceipt, next: string): Promise<void> {
  const current = await tabUrls.get(live.open.actionId);
  if (!lives.has(live.open.actionId)) return;
  if (current && next && sameDocument(current, next)) {
    noteNavigationDone(live.open, Date.now());
    return;
  }
  live.body.navigated = true;
}

function noteCreatedDownload(item: chrome.downloads.DownloadItem): void {
  const lookup = matchDownload(item).finally(() => lookups.delete(lookup));
  lookups.add(lookup);
}

async function matchDownload(item: chrome.downloads.DownloadItem): Promise<void> {
  for (const [actionId, live] of [...lives].reverse()) {
    if (live.body.download) continue;
    const url = await tabUrls.get(actionId);
    if (!url || !sameOrigin(url, item.referrer || item.url)) continue;
    live.body.download = {
      url: item.url.slice(0, 2000),
      filename: (item.filename.split(/[\\/]/).pop() || item.url.split("/").pop() || "").slice(
        0,
        300,
      ),
    };
    noteDownload(live.open, Date.now());
    return;
  }
}

async function drainLookups(): Promise<void> {
  if (lookups.size) await Promise.all([...lookups]);
  if (lookups.size) await Promise.all([...lookups]);
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function sameDocument(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.origin === right.origin &&
      left.pathname === right.pathname &&
      left.search === right.search
    );
  } catch {
    return false;
  }
}

onEngineInstall(() => {
  chrome.downloads?.onCreated.addListener(noteCreatedDownload);
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    const live = liveFor(source.tabId, method === "Network.requestWillBeSent");
    if (!live) return;
    const data = (params ?? {}) as Record<string, unknown>;
    if (method.startsWith("Network.")) applyNetwork(live, method, data);
    else if (method === "Page.javascriptDialogClosed") onDialogClosed(live, data);
    else if (method === "Page.downloadWillBegin") onDownload(live, data);
    else if (method === "Page.frameNavigated") onFrame(live, data);
    else if (method === "Page.loadEventFired" || method === "Page.navigatedWithinDocument")
      noteNavigationDone(live.open, Date.now());
  });
});

function applyNetwork(live: LiveReceipt, method: string, params: Record<string, unknown>): void {
  if (method === "Network.requestWillBeSent") onRequest(live, params);
  else if (method === "Network.responseReceived") onResponse(live, params);
  else if (method === "Network.loadingFailed") onFailed(live, params);
  else if (method === "Network.loadingFinished")
    noteRequestEnd(live.open, { id: String(params.requestId ?? ""), at: Date.now() });
}
