// A receipt belongs to one action. It closes when everything that action could have caused has
// finished and stayed quiet, or at a cap. Ordinary clicks with nothing in flight close at once.

export const QUIET_MS = 150;
export const CAUSAL_MS = 500;
/** After a dialog the page's own code runs on (a download, a submit); a busy machine can be slow. */
export const AFTER_DIALOG_MS = 1_500;
export const CAP_MS = 3_000;
export const LONG_CAP_MS = 15_000;

export interface TrackedRequest {
  method: string;
  url: string;
  status?: number;
  error?: string;
}

export interface OpenReceipt {
  actionId: string;
  tabId: number;
  startedAt: number;
  pending: Set<string>;
  lastProgressAt: number;
  dialogClosedAt?: number;
  /** A dialog opened after this action, so the close waits out the causal window. */
  dialog: boolean;
  /** A download was named or a navigation started: the cap becomes 15s. */
  extended: boolean;
  /** A request landed here while another receipt on the tab was still open. */
  overlap: boolean;
  sawDownload: boolean;
  labels: Map<string, string>;
  requests: Map<string, TrackedRequest>;
  holdUntil?: number;
  notify?: () => void;
}

export interface ClosedReceipt {
  open?: string[];
}

export interface QuietOptions {
  quietMs?: number;
  capMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createOpenReceipt(actionId: string, tabId: number, now = Date.now()): OpenReceipt {
  return {
    actionId,
    tabId,
    startedAt: now,
    pending: new Set(),
    lastProgressAt: now,
    dialog: false,
    extended: false,
    overlap: false,
    sawDownload: false,
    labels: new Map(),
    requests: new Map(),
  };
}

/** A request counts only inside 500ms of the action, of a dialog close, or of the close hold. */
export function inCausalWindow(receipt: OpenReceipt, now: number): boolean {
  if (now - receipt.startedAt <= CAUSAL_MS) return true;
  if (receipt.dialogClosedAt !== undefined && now - receipt.dialogClosedAt <= AFTER_DIALOG_MS)
    return true;
  return receipt.holdUntil !== undefined && now <= receipt.holdUntil;
}

export function noteDialogOpen(receipt: OpenReceipt, now: number): void {
  receipt.dialog = true;
  join(receipt, "dialog", "dialog", now);
}

export function noteDialogClose(receipt: OpenReceipt, now: number): void {
  receipt.dialog = true;
  receipt.dialogClosedAt = now;
  receipt.pending.delete("dialog");
  touch(receipt, now);
}

export function noteRequestStart(
  receipt: OpenReceipt,
  input: { id: string; method: string; url: string; at: number },
): boolean {
  if (!input.id || !inCausalWindow(receipt, input.at)) return false;
  const item = receipt.requests.get(input.id) ?? {
    method: input.method.slice(0, 20),
    url: input.url.slice(0, 500),
  };
  receipt.requests.set(input.id, item);
  join(receipt, requestKey(input.id), `request:${requestPath(input.url)}`, input.at);
  return true;
}

export function noteRequestEnd(
  receipt: OpenReceipt,
  input: { id: string; at: number; status?: number; error?: string },
): void {
  const item = receipt.requests.get(input.id);
  if (!item) return;
  const removed = receipt.pending.delete(requestKey(input.id));
  if (input.status !== undefined) item.status = input.status;
  if (input.error) item.error = input.error.slice(0, 200);
  if (removed || input.status !== undefined || input.error) touch(receipt, input.at);
}

/** The download's name is the evidence, so it does not stay pending after it is known. */
export function noteDownload(receipt: OpenReceipt, now: number): void {
  receipt.extended = true;
  receipt.sawDownload = true;
  touch(receipt, now);
}

export function noteNavigationStart(receipt: OpenReceipt, now: number): void {
  receipt.extended = true;
  join(receipt, "navigation", "navigation", now);
}

export function noteNavigationDone(receipt: OpenReceipt, now: number): void {
  leave(receipt, "navigation", now);
}

export function requestPath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

export function settledRequests(receipt: OpenReceipt): TrackedRequest[] {
  return [...receipt.requests.values()];
}

export function pendingLabels(receipt: OpenReceipt): string[] {
  return [...receipt.pending].map((key) => receipt.labels.get(key) ?? key).slice(0, 20);
}

/** The newest open receipt on a tab. A shared request marks that one as overlapping. */
export function chooseReceipt(
  open: readonly OpenReceipt[],
  tabId: number,
  share: boolean,
): OpenReceipt | undefined {
  const onTab = open.filter((item) => item.tabId === tabId);
  const chosen = onTab.at(-1);
  if (chosen && share && onTab.length > 1) chosen.overlap = true;
  return chosen;
}

export function overlapText(open: readonly OpenReceipt[], chosen: OpenReceipt): string | undefined {
  if (!chosen.overlap) return undefined;
  const others = open
    .filter((item) => item.actionId !== chosen.actionId)
    .map((item) => item.actionId);
  return others.length ? `also open: ${others.join(", ")}`.slice(0, 300) : undefined;
}

/**
 * Closes when nothing this action caused is still running, and nothing new has joined for
 * quietMs. Nothing pending and nothing ever joined closes at once. At the cap, `open` names
 * what was still running (`request:/api/export`).
 */
export async function closeWhenQuiet(
  receipt: OpenReceipt,
  options: QuietOptions = {},
): Promise<ClosedReceipt> {
  const quietMs = options.quietMs ?? QUIET_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  if (idle(receipt)) return {};
  holdAfterDialog(receipt, now());
  for (;;) {
    const at = now();
    if (at - receipt.startedAt >= capOf(receipt, options.capMs)) return capped(receipt);
    if (isQuiet(receipt, at, quietMs)) return {};
    await pause(receipt, waitMs(receipt, at, quietMs, options.capMs), sleep);
  }
}

function idle(receipt: OpenReceipt): boolean {
  return (
    receipt.pending.size === 0 &&
    !receipt.dialog &&
    !receipt.extended &&
    receipt.lastProgressAt === receipt.startedAt
  );
}

function holdAfterDialog(receipt: OpenReceipt, now: number): void {
  // Settle can use up the 500ms after a dialog before we ask to close. Hold one causal window
  // from this moment so the page code that runs after confirm (a download, a request) can join.
  if (receipt.dialog && receipt.holdUntil === undefined) receipt.holdUntil = now + AFTER_DIALOG_MS;
}

function isQuiet(receipt: OpenReceipt, now: number, quietMs: number): boolean {
  if (receipt.pending.size > 0) return false;
  if (receipt.holdUntil !== undefined && now < receipt.holdUntil) return false;
  if (receipt.dialogClosedAt !== undefined && now < receipt.dialogClosedAt + AFTER_DIALOG_MS)
    return false;
  return now - receipt.lastProgressAt >= quietMs;
}

function capOf(receipt: OpenReceipt, capMs: number | undefined): number {
  const cap = capMs ?? CAP_MS;
  return receipt.extended ? Math.max(cap, LONG_CAP_MS) : cap;
}

function waitMs(
  receipt: OpenReceipt,
  now: number,
  quietMs: number,
  capMs: number | undefined,
): number {
  const capAt = receipt.startedAt + capOf(receipt, capMs);
  if (receipt.pending.size > 0) return Math.max(1, capAt - now);
  const quietAt = receipt.lastProgressAt + quietMs;
  const holdAt = Math.max(receipt.holdUntil ?? now, dialogUntil(receipt));
  return Math.max(1, Math.min(capAt, Math.max(quietAt, holdAt)) - now);
}

function dialogUntil(receipt: OpenReceipt): number {
  return receipt.dialogClosedAt === undefined ? 0 : receipt.dialogClosedAt + AFTER_DIALOG_MS;
}

function capped(receipt: OpenReceipt): ClosedReceipt {
  const open = pendingLabels(receipt);
  return open.length ? { open } : {};
}

function join(receipt: OpenReceipt, key: string, label: string, now: number): void {
  receipt.labels.set(key, label.slice(0, 300));
  if (receipt.pending.has(key)) return;
  receipt.pending.add(key);
  touch(receipt, now);
}

function leave(receipt: OpenReceipt, key: string, now: number): void {
  if (!receipt.pending.delete(key)) return;
  touch(receipt, now);
}

function touch(receipt: OpenReceipt, now: number): void {
  receipt.lastProgressAt = now;
  receipt.notify?.();
}

function requestKey(id: string): string {
  return `request:${id}`;
}

function pause(
  receipt: OpenReceipt,
  ms: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (receipt.notify === finish) delete receipt.notify;
      resolve();
    };
    receipt.notify = finish;
    void sleep(ms).then(finish);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
