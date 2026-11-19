import { recordingMessage } from "./code-offscreen-recorder.js";

// Hosts one sandboxed realm per ACTIVE chat and relays its browser calls to the service worker.
// A long browser.job (many pages) gets its own realm and stays alive after its cell returns.
// A realm holds the chat's REPL variables, so dropping it at the end of a run would lose them;
// instead keep a small LRU working set and evict realms that have not run a cell in a while.
// A run leaves one realm per chat behind otherwise: a batch of 23 chats pins 23 iframes, each with
// the whole code API, keeping the offscreen document's memory and CPU growing with chat history.
interface Realm {
  frame: HTMLIFrameElement;
  ready: Promise<void>;
  usedAt: number;
}
interface JobRealm extends Realm {
  chatId: string;
  busy: boolean;
  startedAt: number;
}
interface Cell {
  chatId: string;
  startedAt: number;
  reply: (value: unknown) => void;
}
// A chat can pause for minutes while the model thinks; its REPL must survive that. Evict only
// after a long idle, and keep a small working set so 23 chats cannot pin 23 iframes.
const MAX_REALMS = 4;
const MAX_JOB_REALMS = 2;
const REALM_IDLE_MS = 20 * 60_000;
const CELL_MAX_MS = 10 * 60_000;
const SWEEP_MS = 30_000;
const realms = new Map<string, Realm>();
const jobRealms = new Map<string, JobRealm>();
const cells = new Map<string, Cell>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function makeFrame(): { frame: HTMLIFrameElement; ready: Promise<void>; usedAt: number } {
  const frame = document.createElement("iframe");
  frame.src = "code-sandbox.html";
  const ready = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  document.body.append(frame);
  return { frame, ready, usedAt: Date.now() };
}

function realm(chatId: string): Realm {
  const existing = realms.get(chatId);
  if (existing) {
    existing.usedAt = Date.now();
    return existing;
  }
  const created = makeFrame();
  realms.set(chatId, created);
  scheduleSweep();
  return created;
}

function jobRealm(jobId: string, chatId: string): JobRealm {
  const existing = jobRealms.get(jobId);
  if (existing) {
    existing.usedAt = Date.now();
    return existing;
  }
  const created = { ...makeFrame(), chatId, busy: false, startedAt: Date.now() };
  jobRealms.set(jobId, created);
  scheduleSweep();
  return created;
}

/** A chat with a cell in flight owns its realm; never evict one that still has work to answer. */
function hasCell(chatId: string): boolean {
  for (const cell of cells.values()) if (cell.chatId === chatId) return true;
  return false;
}

/**
 * Bound the working set: idle realms go after REALM_IDLE_MS, and the least recently used go first
 * past MAX_REALMS. Jobs in flight are busy through their own `done`, so they are never evicted.
 * Exported for the invariant test; the sweep timer calls this and stops itself when nothing is left.
 */
export function sweepRealms(now = Date.now()): void {
  for (const [jobId, job] of jobRealms) {
    // A job whose cell never answered (its deadline passed in the service worker) is no longer
    // busy; otherwise one abandoned job pins its realm for the life of the document.
    if (job.busy && (now - job.startedAt >= CELL_MAX_MS || now - job.usedAt >= REALM_IDLE_MS))
      job.busy = false;
    if (!job.busy && now - job.usedAt >= REALM_IDLE_MS) {
      job.frame.remove();
      jobRealms.delete(jobId);
    }
  }
  const jobExcess = jobRealms.size - MAX_JOB_REALMS;
  if (jobExcess > 0) {
    const lruJobs = [...jobRealms]
      .filter(([, job]) => !job.busy)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [jobId, job] of lruJobs.slice(0, jobExcess)) {
      job.frame.remove();
      jobRealms.delete(jobId);
    }
  }
  for (const [chatId, existing] of realms) {
    if (hasCell(chatId)) {
      existing.usedAt = now;
      continue;
    }
    if (now - existing.usedAt >= REALM_IDLE_MS) drop(chatId);
  }
  // Then cap: past MAX_REALMS drop the least recently used idle chats. A chat with a cell in
  // flight keeps its REPL; dropping that would break the run, so the cap only binds at rest.
  const excess = realms.size - MAX_REALMS;
  if (excess > 0) {
    const lru = [...realms]
      .filter(([id]) => !hasCell(id))
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [chatId] of lru.slice(0, excess)) if (realms.has(chatId)) drop(chatId);
  }
  // A cell that never got a `done` (a deadline passed in the service worker) must not pin a realm
  // or accumulate reply callbacks for the life of the document.
  for (const [cellId, cell] of cells)
    if (now - cell.startedAt >= CELL_MAX_MS) {
      cells.delete(cellId);
      cell.reply({ output: "", error: "TIMEOUT: browser cell did not finish" });
    }
  if (!realms.size && !jobRealms.size && !cells.size && sweepTimer !== undefined) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

function scheduleSweep(): void {
  if (sweepTimer !== undefined) return;
  sweepTimer = setInterval(() => sweepRealms(), SWEEP_MS);
}

/** Test seam: the number of live sandboxed realms (chat realms plus job realms). */
export function realmCount(): number {
  return realms.size + jobRealms.size;
}

/** Test seam: stop the sweep when a test owns the document for the rest of the process. */
export function stopSweep(): void {
  if (sweepTimer !== undefined) clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/** Tell the service worker how far this cell got, for the deadline error. */
function stage(cellId: string, value: string): void {
  if (!cells.has(cellId)) return;
  void chrome.runtime
    .sendMessage({ target: "aeon-code-host", kind: "stage", cellId, stage: value })
    .catch(() => undefined);
}

function drop(chatId: string): void {
  const frame = realms.get(chatId)?.frame;
  frame?.contentWindow?.postMessage({ kind: "stop" }, "*");
  frame?.remove();
  realms.delete(chatId);
  for (const [jobId, job] of jobRealms)
    if (job.chatId === chatId) {
      job.frame.remove();
      jobRealms.delete(jobId);
    }
  for (const [cellId, cell] of cells)
    if (cell.chatId === chatId) {
      cells.delete(cellId);
      cell.reply({ output: "", error: "RUN_RESET: browser runtime reset", reset: true });
    }
}

window.addEventListener("message", (event) => {
  const message = event.data as {
    kind?: string;
    cellId?: string;
    callId?: string;
    request?: unknown;
  };
  const source = [...realms.entries()].find(
    ([, item]) => item.frame.contentWindow === event.source,
  );
  const job = [...jobRealms.entries()].find(
    ([, item]) => item.frame.contentWindow === event.source,
  );
  if ((!source && !job) || typeof message?.cellId !== "string") return;
  const chatId = source?.[0] ?? job?.[1].chatId;
  const jobId = job?.[0];
  const frame = source?.[1].frame ?? job?.[1].frame;
  if (!frame) return;
  if (message.kind === "call") {
    void chrome.runtime
      .sendMessage({
        target: "aeon-code-host",
        kind: "call",
        cellId: message.cellId,
        request: message.request,
      })
      .then(
        (response: { value?: unknown; error?: string } | undefined) =>
          response ?? { error: "Browser host unavailable" },
        (error: unknown) => ({ error: String(error) }),
      )
      .then((response) =>
        frame.contentWindow?.postMessage(
          { kind: "reply", callId: message.callId, ...response },
          "*",
        ),
      );
    return;
  }
  if (message.kind === "done" && jobId) {
    jobRealms.get(jobId)?.frame.remove();
    jobRealms.delete(jobId);
    const done = message as Record<string, unknown>;
    void chrome.runtime.sendMessage({
      target: "aeon-code-host",
      kind: "jobDone",
      jobId,
      value: done.value,
      output: done.output,
      ...(done.error ? { error: done.error } : {}),
      chatId,
    });
    return;
  }
  if (message.kind === "started") {
    stage(message.cellId, "evaluating");
    return;
  }
  if (message.kind === "done") {
    const cell = cells.get(message.cellId);
    if (!cell || cell.chatId !== chatId) return;
    stage(message.cellId, "result-sent");
    cells.delete(message.cellId);
    const done = message as Record<string, unknown>;
    cell.reply({ value: done.value, output: done.output, error: done.error });
  }
});

let clipboardBackup: { text: string; html: string } | undefined;
let clipboardBusy = false;
async function clipboardSwap(text: string, html: string): Promise<Record<string, unknown>> {
  if (clipboardBusy) return { error: "CLIPBOARD_BUSY" };
  clipboardBusy = true;
  try {
    clipboardBackup = { text: await navigator.clipboard.readText().catch(() => ""), html: "" };
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    return { ok: true };
  } catch (error) {
    clipboardBackup = undefined;
    return { error: String(error) };
  }
}
async function clipboardRestore(): Promise<Record<string, unknown>> {
  try {
    if (clipboardBackup)
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([clipboardBackup.text], { type: "text/plain" }),
        }),
      ]);
    return { ok: true };
  } catch (error) {
    return { error: String(error) };
  } finally {
    clipboardBackup = undefined;
    clipboardBusy = false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-offscreen" || sender.id !== chrome.runtime.id) return;
  if (message.kind === "ping") {
    reply({ ok: true });
    return;
  }
  if (message.kind === "clipboardSwap") {
    void clipboardSwap(String(message.text ?? ""), String(message.html ?? "")).then(reply);
    return true;
  }
  if (message.kind === "clipboardRestore") {
    void clipboardRestore().then(reply);
    return true;
  }
  if (message.kind === "reset") {
    drop(message.chatId);
    reply(true);
    return;
  }
  if (message.kind === "job") {
    const target = jobRealm(message.jobId, message.chatId);
    target.busy = true;
    target.usedAt = Date.now();
    target.startedAt = target.usedAt;
    void target.ready.then(() =>
      target.frame.contentWindow?.postMessage(
        { kind: "cell", cellId: message.jobId, code: message.code },
        "*",
      ),
    );
    reply(true);
    return true;
  }
  if (message.kind === "stopJobs") {
    for (const [jobId, job] of jobRealms)
      if (job.chatId === message.chatId && (!message.jobId || message.jobId === jobId)) {
        job.frame.remove();
        jobRealms.delete(jobId);
      }
    reply(true);
    return;
  }
  const recorded = recordingMessage(message);
  if (recorded) {
    void recorded.then(reply, (error: unknown) => reply({ ok: false, error: String(error) }));
    return true;
  }
  if (message.kind !== "cell") return;
  const target = realm(message.chatId);
  cells.set(message.cellId, { chatId: message.chatId, startedAt: Date.now(), reply });
  stage(message.cellId, "offscreen");
  void target.ready.then(() => {
    stage(message.cellId, "realm-ready");
    target.frame.contentWindow?.postMessage(
      {
        kind: "cell",
        cellId: message.cellId,
        code: message.code,
        attached: message.attached,
      },
      "*",
    );
  });
  return true;
});
