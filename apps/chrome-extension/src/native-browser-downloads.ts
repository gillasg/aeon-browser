import type { BrowserExecutorRequest } from "@pippin/protocol";
import { browserSessionOwner } from "./native-browser-session.js";
import { publishBrowserEvent } from "./native-browser-events.js";
import { ownsDownload, rememberDownload } from "./native-browser-download-state.js";
interface Token {
  chatId: string;
  tabId: number;
  url: string;
  at: number;
  downloadId?: number;
}
const tokens = new Map<string, Token>();
chrome.debugger.onEvent.addListener((source, method, raw) => {
  if (source.tabId === undefined || method !== "Page.downloadWillBegin") return;
  const chatId = browserSessionOwner(source.tabId),
    params = raw as { url: string; guid: string; suggestedFilename?: string };
  if (!chatId) return;
  const token = crypto.randomUUID();
  tokens.set(token, { chatId, tabId: source.tabId, url: params.url, at: Date.now() });
  while (tokens.size > 128) tokens.delete(tokens.keys().next().value ?? "");
  publishBrowserEvent(source.tabId, "download", { ...params, token }, source.sessionId);
});
type Download = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "downloads" }>;
};
export async function executeDownload(request: Download): Promise<unknown> {
  const step = request.step;
  if (step.action === "start") return startDownload(request);
  if (step.action === "resolve") return resolveDownload(request);
  if (
    step.downloadId === undefined ||
    !(await ownsDownload(step.downloadId, request.chatId, step.target))
  )
    throw new Error("INVALID_TARGET");
  if (step.action === "cancel") {
    await chrome.downloads.cancel(step.downloadId);
    return { cancelled: true };
  }
  const deadline = Date.now() + step.timeoutMs;
  do {
    const items = await chrome.downloads.search({ id: step.downloadId }),
      item = items[0];
    if (!item) throw new Error("Download disappeared");
    if (item.state !== "in_progress" || Date.now() >= deadline) return metadata(item);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() <= deadline + 100);
  throw new Error("TIMEOUT");
}
async function resolveDownload(request: Download): Promise<unknown> {
  const token = tokens.get(request.step.token ?? "");
  if (!token || token.chatId !== request.chatId || token.tabId !== request.step.target.tabId)
    throw new Error("INVALID_TARGET");
  if (token.downloadId !== undefined) {
    const item = (await chrome.downloads.search({ id: token.downloadId }))[0];
    if (!item) throw new Error("Download disappeared");
    return metadata(item);
  }
  const matches = (
    await chrome.downloads.search({ startedAfter: new Date(token.at - 2000).toISOString() })
  ).filter((item) => item.url === token.url || item.finalUrl === token.url);
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "AMBIGUOUS_TARGET"
        : "Download not registered yet; retry resolution, not the export action",
    );
  const item = matches[0];
  if (!item) throw new Error("INVALID_TARGET");
  await rememberDownload(item.id, request.chatId, request.step.target);
  token.downloadId = item.id;
  return metadata(item);
}
function metadata(item: chrome.downloads.DownloadItem): unknown {
  return {
    downloadId: item.id,
    state: item.state,
    filename: item.filename,
    url: item.finalUrl ?? item.url,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    exists: item.exists,
    error: item.error,
  };
}

async function startDownload(request: Download): Promise<unknown> {
  const step = request.step;

  if (!step.url || !/^https?:\/\//.test(step.url)) throw new Error("INVALID_TARGET");
  if (step.filename && (step.filename.includes("..") || /^[\\/]|:/.test(step.filename)))
    throw new Error("Invalid download filename");
  const downloadId = await chrome.downloads.download({
    url: step.url,
    ...(step.filename ? { filename: step.filename } : {}),
    saveAs: false,
    conflictAction: "uniquify",
  });
  const persisted = await rememberDownload(downloadId, request.chatId, step.target);
  return { downloadId, state: "in_progress", persisted };
}
