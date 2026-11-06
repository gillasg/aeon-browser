import { onEngineInstall } from "./native-engine-install.js";

// Per-tab receipts for one action: popups it opened, a dialog it raised, a download it started,
// the fetch/XHR calls it caused (so a submit shows whether the server took it), and whether the
// page navigated. Subscribers are intentionally not the source: they are per
// chat and would also report work started outside the action being measured.
export interface ActionReceipt {
  popups: { tabId: number; url: string }[];
  dialog?: { type: string; message: string; accepted: boolean };
  navigated: boolean;
  download?: { url: string; filename: string; token?: string };
  requests?: ReceiptRequest[];
}
export interface ReceiptRequest {
  method: string;
  url: string;
  status?: number;
  error?: string;
}

/** Calls kept per receipt; failures are always kept over successes. */
const MAX_REQUESTS = 8;
const pending = new Map<string, ReceiptRequest>();

const receipts = new Map<number, ActionReceipt>();
/** When each tab's dialog closed during the action: the page's code only goes on after that. */
const dialogClosed = new Map<number, number>();

export function beginReceipt(tabId: number): void {
  dialogClosed.delete(tabId);
  receipts.set(tabId, { popups: [], navigated: false });
}

export function noteReceiptPopup(openerId: number, tabId: number, url = ""): void {
  const receipt = receipts.get(openerId);
  if (!receipt) return;
  receipt.popups.push({ tabId, url });
}

/**
 * Code after a dialog (a download, a request) runs only once the dialog is accepted, which can be
 * after the page looked settled: give it a moment so the receipt names what it did.
 */
export async function receiptQuiet(tabId: number, quietMs = 500): Promise<void> {
  const closed = dialogClosed.get(tabId);
  if (closed === undefined) return;
  const wait = closed + quietMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, quietMs)));
}

export function takeReceipt(tabId: number): ActionReceipt {
  dialogClosed.delete(tabId);
  const receipt = receipts.get(tabId) ?? { popups: [], navigated: false };
  receipts.delete(tabId);
  if (receipt.requests) {
    for (const [id, item] of pending) if (receipt.requests.includes(item)) pending.delete(id);
    receipt.requests = keptRequests(receipt.requests);
  }
  return receipt;
}

function keptRequests(requests: ReceiptRequest[]): ReceiptRequest[] {
  const failed = requests.filter((item) => item.error || (item.status ?? 0) >= 400);
  const rest = requests.filter((item) => !failed.includes(item));
  return [...failed, ...rest].slice(0, MAX_REQUESTS);
}

function noteNetwork(
  receipt: ActionReceipt,
  method: string,
  params: Record<string, unknown>,
): void {
  const id = String(params.requestId ?? "");
  if (method === "Network.requestWillBeSent") {
    if (params.type !== "XHR" && params.type !== "Fetch") return;
    const request = (params.request ?? {}) as { method?: string; url?: string };
    const item = {
      method: String(request.method ?? "GET"),
      url: String(request.url ?? "").slice(0, 500),
    };
    (receipt.requests ??= []).push(item);
    pending.set(id, item);
    return;
  }
  const item = pending.get(id);
  if (!item) return;
  if (method === "Network.responseReceived")
    item.status = Number((params.response as { status?: number } | undefined)?.status ?? 0);
  else if (method === "Network.loadingFailed") {
    item.error = String(params.errorText ?? "failed").slice(0, 200);
    pending.delete(id);
  } else if (method === "Network.loadingFinished") pending.delete(id);
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    const receipt = receipts.get(source.tabId);
    if (!receipt) return;
    if (method.startsWith("Network.")) {
      noteNetwork(receipt, method, (params ?? {}) as Record<string, unknown>);
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      const value = params as { type?: string; message?: string };
      receipt.dialog = {
        type: String(value.type ?? "alert"),
        message: String(value.message ?? "").slice(0, 300),
        accepted: true,
      };
    } else if (method === "Page.javascriptDialogClosed") {
      if (receipt.dialog)
        receipt.dialog.accepted = Boolean((params as { result?: unknown }).result);
      dialogClosed.set(source.tabId, Date.now());
    } else if (method === "Page.downloadWillBegin") {
      const value = params as { url?: string; suggestedFilename?: string; guid?: string };
      receipt.download = {
        url: String(value.url ?? "").slice(0, 2000),
        filename: String(value.suggestedFilename ?? "").slice(0, 300),
        ...(value.guid ? { token: value.guid } : {}),
      };
    }
  });
});
