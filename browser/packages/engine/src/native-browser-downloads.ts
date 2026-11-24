import type { BrowserTargetKey, BrowserExecutorRequest } from "@browserkit/protocol";
import { browserSessionOwner } from "./native-browser-session.js";
import { publishBrowserEvent } from "./native-browser-events.js";
import { onEngineInstall } from "./native-engine-install.js";
import {
  base64Bytes,
  bytesBase64,
  evaluate,
  scrubText,
  scrubUrl,
  sha256Hex,
  type ClawPort,
} from "./native-browser-claw-port.js";

interface Owner {
  chatId: string;
  target: BrowserTargetKey;
}
const key = "aeon-download-owners",
  owners = new Map<number, Owner>();
let loading: Promise<void> | undefined,
  writes: Promise<unknown> = Promise.resolve();
export async function ownsDownload(
  id: number,
  chatId: string,
  target: BrowserTargetKey,
): Promise<boolean> {
  await load();
  const owner = owners.get(id);
  return (
    !!owner &&
    owner.chatId === chatId &&
    owner.target.clientInstanceId === target.clientInstanceId &&
    owner.target.browserRunId === target.browserRunId
  );
}
export async function rememberDownload(
  id: number,
  chatId: string,
  target: BrowserTargetKey,
): Promise<boolean> {
  await load();
  const owner = owners.get(id);
  if (owner && owner.chatId !== chatId) throw new Error("CLAIM_CONFLICT");
  owners.set(id, { chatId, target });
  while (owners.size > 256) owners.delete(owners.keys().next().value ?? -1);
  if (chrome.storage?.session) {
    const data = [...owners];
    writes = writes.catch(() => undefined).then(() => chrome.storage.session.set({ [key]: data }));
    try {
      await writes;
    } catch {
      return false;
    }
  }
  return true;
}
async function load(): Promise<void> {
  loading ??= readStored();
  return loading;
}
async function readStored(): Promise<void> {
  if (!chrome.storage?.session) return;
  const data = (await chrome.storage.session.get(key))[key] as [number, Owner][] | undefined;
  for (const [id, owner] of data ?? []) if (!owners.has(id)) owners.set(id, owner);
}

interface Token {
  chatId: string;
  tabId: number;
  url: string;
  at: number;
  downloadId?: number;
}
const tokens = new Map<string, Token>();
onEngineInstall(() => {
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

// ---------- page.downloads: a lazy CDP download bus ----------
// Off until start(): then Browser.setDownloadBehavior turns download events on for this tab and
// every download it begins is tracked from willBegin through inProgress to completed or
// canceled. stop() (or a detach) turns events off again; nothing listens while idle.
export type DownloadState = "willBegin" | "inProgress" | "completed" | "canceled";
export interface TrackedDownload {
  guid: string;
  url: string;
  suggestedFilename: string;
  state: DownloadState;
  totalBytes: number;
  receivedBytes: number;
  localPath?: string;
  startedAt: number;
  endedAt?: number;
}
export interface DownloadFilter {
  url?: string;
  filename?: string;
  state?: DownloadState;
}
type Waiting = { filter: DownloadFilter; done: (item: TrackedDownload) => void };
const DOWNLOAD_STATES: Record<string, DownloadState> = {
  inProgress: "inProgress",
  completed: "completed",
  canceled: "canceled",
};

export class DownloadBus {
  private on = false;
  private off: (() => void) | undefined;
  private downloadPath: string | undefined;
  private readonly items = new Map<string, TrackedDownload>();
  private readonly waiting = new Set<Waiting>();
  constructor(
    private readonly port: ClawPort,
    private readonly max = 100,
  ) {}

  enabled(): string[] {
    return this.on ? ["Browser.downloadEvents"] : [];
  }

  async start(options: { downloadPath?: unknown } = {}): Promise<unknown> {
    const path = typeof options.downloadPath === "string" ? options.downloadPath : undefined;
    if (!this.on) this.off = this.port.on((method, params) => this.onEvent(method, params));
    this.downloadPath = path;
    const behavior = path
      ? { behavior: "allowAndName", downloadPath: path, eventsEnabled: true }
      : { behavior: "default", eventsEnabled: true };
    try {
      await this.port.send("Browser.setDownloadBehavior", behavior);
    } catch (error) {
      if (!this.on) {
        this.off?.();
        this.off = undefined;
      }
      throw error;
    }
    this.on = true;
    return { tracking: true, ...(path ? { downloadPath: path } : {}) };
  }

  private onEvent(method: string, raw: Record<string, unknown>): void {
    const name = method.replace(/^(Browser|Page)\./, "");
    const guid = String(raw.guid ?? "");
    if (!guid) return;
    if (name === "downloadWillBegin") {
      const filename = String(raw.suggestedFilename ?? "");
      if (this.items.has(guid)) return;
      this.items.set(guid, {
        guid,
        url: scrubUrl(String(raw.url ?? "")),
        suggestedFilename: filename,
        state: "willBegin",
        totalBytes: 0,
        receivedBytes: 0,
        ...(this.downloadPath ? { localPath: `${this.downloadPath}/${guid}` } : {}),
        startedAt: Date.now(),
      });
      while (this.items.size > this.max) this.items.delete(this.items.keys().next().value ?? "");
    } else if (name === "downloadProgress") this.progress(guid, raw);
    const item = this.items.get(guid);
    if (item) this.settle(item);
  }

  private progress(guid: string, raw: Record<string, unknown>): void {
    const item = this.items.get(guid);
    const state = DOWNLOAD_STATES[String(raw.state)];
    if (!item || !state) return;
    item.state = state;
    item.totalBytes = Number(raw.totalBytes) || item.totalBytes;
    item.receivedBytes = Number(raw.receivedBytes) || item.receivedBytes;
    if (typeof raw.filePath === "string" && raw.filePath) item.localPath = raw.filePath;
    if (state !== "inProgress") item.endedAt = Date.now();
  }

  private settle(item: TrackedDownload): void {
    for (const wait of [...this.waiting])
      if (matchesDownload(item, wait.filter)) {
        this.waiting.delete(wait);
        wait.done({ ...item });
      }
  }

  list(filter: DownloadFilter = {}): TrackedDownload[] {
    return [...this.items.values()]
      .filter((d) => matchesDownload(d, filter))
      .map((d) => ({ ...d }));
  }

  /** The first download matching the filter (state defaults to completed), or TIMEOUT. */
  waitFor(filter: DownloadFilter = {}, timeoutMs = 30000): Promise<TrackedDownload> {
    if (!this.on)
      return Promise.reject(new Error("INVALID_INPUT: call page.downloads.start() first"));
    const want = { state: "completed" as DownloadState, ...filter };
    const seen = this.list(want)[0];
    if (seen) return Promise.resolve(seen);
    const ms = Math.min(Math.max(Number(timeoutMs) || 30000, 1), 120000);
    return new Promise((resolve, reject) => {
      const wait: Waiting = {
        filter: want,
        done: (item) => {
          clearTimeout(timer);
          resolve(item);
        },
      };
      const timer = setTimeout(() => {
        this.waiting.delete(wait);
        reject(new Error(`TIMEOUT: no ${want.state} download matched in ${ms}ms`));
      }, ms);
      this.waiting.add(wait);
    });
  }

  async stop(): Promise<unknown> {
    if (!this.on) return { tracking: false };
    this.forget();
    await this.port
      .send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false })
      .catch(() => undefined);
    return { tracking: false };
  }

  detached(): void {
    this.forget();
  }

  private forget(): void {
    this.on = false;
    this.off?.();
    this.off = undefined;
    for (const wait of this.waiting) wait.done = () => undefined;
    this.waiting.clear();
  }
}

function matchesDownload(item: TrackedDownload, filter: DownloadFilter): boolean {
  if (filter.state && item.state !== filter.state) return false;
  if (filter.url && !item.url.includes(filter.url)) return false;
  return !filter.filename || item.suggestedFilename.includes(filter.filename);
}

// ---------- page.archive: deterministic PDF / MHTML receipts ----------
export interface ArchiveReceipt {
  kind: "pdf" | "mhtml";
  mime: string;
  bytes: number;
  sha256: string;
  url: string;
  title: string;
  capturedAt: string;
  base64?: string;
}
const PDF_OPTIONS = [
  "landscape",
  "printBackground",
  "scale",
  "paperWidth",
  "paperHeight",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "pageRanges",
  "preferCSSPageSize",
] as const;

/** Captures the page as PDF or MHTML and describes it: digest, size, where it came from. */
export async function archivePage(
  port: ClawPort,
  kind: "pdf" | "mhtml",
  options: Record<string, unknown> = {},
): Promise<ArchiveReceipt> {
  const where = await evaluate<{ url?: string; title?: string }>(
    port,
    "({url: location.href, title: document.title})",
  );
  let bytes: Uint8Array;
  if (kind === "pdf") {
    const params: Record<string, unknown> = { printBackground: true };
    for (const key of PDF_OPTIONS) if (options[key] !== undefined) params[key] = options[key];
    const reply = await port.send<{ data?: string }>("Page.printToPDF", params);
    bytes = base64Bytes(String(reply.data ?? ""));
  } else {
    const reply = await port.send<{ data?: string }>("Page.captureSnapshot", { format: "mhtml" });
    bytes = new TextEncoder().encode(String(reply.data ?? ""));
  }
  return {
    kind,
    mime: kind === "pdf" ? "application/pdf" : "multipart/related",
    bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    url: scrubUrl(String(where?.url ?? "")),
    title: scrubText(String(where?.title ?? "")),
    capturedAt: new Date().toISOString(),
    ...(options.base64 === true || options.save ? { base64: bytesBase64(bytes) } : {}),
  };
}
