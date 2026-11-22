import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  BrowserCodeCallSchema,
  BrowserCodeProgressSchema,
  BrowserCodeResultSchema,
  BrowserCodeRunSchema,
  BrowserTargetKeySchema,
  clampTimeoutMs,
  type BrowserCodeResult,
  type BrowserCodeStage,
  type BrowserTargetKey,
} from "@aeon/protocol";

export interface BrowserCodeCellInput {
  code: string;
  timeoutMs: number;
  ownerTitle?: string;
  /** Where this cell's tabs go unless a step chooses; decided from the chat's origin. */
  space?: "window" | "tabs";
  /** Human-verification assistance is only for cells the user started. */
  onCall: (request: unknown) => Promise<unknown>;
  onProgress: (steps: Record<string, unknown>[]) => void;
}
interface Pending {
  clientInstanceId: string;
  socket: WebSocket;
  input: BrowserCodeCellInput;
  finish: (result?: BrowserCodeResult, error?: Error) => void;
  /** Stops the deadline while the user handles a hand-off; restarts it in full afterwards. */
  waiting: (waiting: boolean) => void;
  /** A short link drop keeps the cell alive; this fails it only after the grace period. */
  closeTimer?: ReturnType<typeof setTimeout>;
  /** The last hop the extension reported; a deadline names it. */
  stage: BrowserCodeStage;
  /** Tabs progress showed this cell opening; a cell that fails still hands them to its chat. */
  opened: Map<number, BrowserTargetKey>;
  /** Set when a 1–999 ms timeout was raised to the schema minimum. */
  timeoutWarn?: string;
}

const LINK_GRACE_MS = 60_000;
/** A browser answers a run at once; silence past this means the connection stalled. */
const ACK_MS = 10_000;
/** How long an interrupted cell may take to post the value it already built. */
const PARTIAL_WAIT_MS = 3_000;

function startedStage(stage: BrowserCodeStage): boolean {
  return stage === "evaluating" || stage === "result-sent";
}

function deadlineMessage(stage: BrowserCodeStage, started: boolean): string {
  if (!started) {
    return `INTERNAL: the browser never started this code; browser code exceeded its deadline (last stage: ${stage}); that cell stopped and its realm was reset.`;
  }
  return `TIMEOUT: browser code exceeded its deadline (last stage: ${stage}); the partial value was not returned and the stuck realm was reset, so this session's variables are gone`;
}

/** Arms the cell deadline. A cell that has started is interrupted and given time to return a partial. */
function deadlineClock(
  stageOf: () => BrowserCodeStage,
  cancel: (reset: boolean) => void,
  finish: (result?: BrowserCodeResult, error?: Error) => void,
  timeoutMs: number,
): { waiting: (paused: boolean) => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = (): void => {
    const stage = stageOf();
    if (!startedStage(stage)) {
      cancel(true);
      finish(undefined, new Error(deadlineMessage(stage, false)));
      return;
    }
    cancel(false);
    clearTimeout(timer);
    // No partial in time: the cell is stuck on a promise that never settles. Reset its realm now,
    // or the next cell in this session (session.close included) queues behind it until the
    // browser's own deadline resets it, ~10 s later.
    timer = setTimeout(() => {
      cancel(true);
      finish(undefined, new Error(deadlineMessage(stage, true)));
    }, PARTIAL_WAIT_MS);
  };
  timer = setTimeout(expire, timeoutMs + 5000);
  return {
    waiting: (paused: boolean) => {
      clearTimeout(timer);
      timer = paused ? undefined : setTimeout(expire, timeoutMs + 5000);
    },
    clear: () => clearTimeout(timer),
  };
}

/** Runs browser_code cells inside a connected executor: one round trip per cell, not per step. */
export class BrowserCodeCells {
  private readonly cells = new Map<string, Pending>();
  constructor(private readonly adopt: (chatId: string, target: BrowserTargetKey) => void) {}

  /** Cells still in flight, including an ability or a routine check. */
  activeCount(): number {
    return this.cells.size;
  }

  run(
    socket: WebSocket,
    clientInstanceId: string,
    chatId: string,
    toolCallId: string,
    targets: BrowserTargetKey[],
    input: BrowserCodeCellInput,
    signal?: AbortSignal,
  ): Promise<BrowserCodeResult> {
    const cellId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = (reset: boolean) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ kind: "browser.code.cancel", cellId, reset }));
      };
      const abort = () => {
        cancel(true);
        finish(undefined, new Error("RUN_RESET: browser workflow cancelled; runtime reset"));
      };
      const close = () => {
        const cell = this.cells.get(cellId);
        if (!cell) return;
        if (cell.closeTimer) clearTimeout(cell.closeTimer);
        cell.closeTimer = setTimeout(() => {
          finish(undefined, new Error("BROWSER_OFFLINE"));
        }, LINK_GRACE_MS);
      };
      const finish = (result?: BrowserCodeResult, error?: Error) => {
        const cell = this.cells.get(cellId);
        if (!this.cells.delete(cellId)) return;
        clock.clear();
        if (cell?.closeTimer) clearTimeout(cell.closeTimer);
        signal?.removeEventListener("abort", abort);
        if (cell) cell.socket.off("close", close);
        if (result) {
          for (const target of result.opened) this.adopt(chatId, target);
          resolve(result);
        } else {
          // A timed-out or reset cell sends no result, but the tabs it opened are still open and
          // are the chat's; unowned, they would be closed before the chat could read them.
          for (const target of cell?.opened.values() ?? []) this.adopt(chatId, target);
          reject(error ?? new Error("INTERNAL: the cell ended without a result"));
        }
      };
      const clock = deadlineClock(
        () => this.cells.get(cellId)?.stage ?? "sent",
        cancel,
        finish,
        input.timeoutMs,
      );
      const bounded = clampTimeoutMs(input.timeoutMs);
      this.cells.set(cellId, {
        clientInstanceId,
        socket,
        input,
        finish,
        waiting: clock.waiting,
        stage: "sent",
        opened: new Map(),
        ...(bounded.warn ? { timeoutWarn: bounded.warn } : {}),
      });
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("close", close);
      this.watchAck(cellId);
      socket.send(
        JSON.stringify(
          BrowserCodeRunSchema.parse({
            kind: "browser.code.run",
            cellId,
            chatId,
            toolCallId,
            code: input.code,
            targets,
            timeoutMs: bounded.timeoutMs,
            ...(input.ownerTitle ? { ownerTitle: input.ownerTitle } : {}),
            ...(input.space ? { space: input.space } : {}),
          }),
        ),
      );
    });
  }

  /**
   * An open socket the browser no longer reads (a suspended worker, a half-open link) held every
   * cell to its full deadline. Unanswered after ACK_MS: drop it so the browser reconnects, and say so.
   */
  private watchAck(cellId: string): void {
    setTimeout(() => {
      const cell = this.cells.get(cellId);
      if (cell?.stage !== "sent") return;
      cell.socket.terminate();
      cell.finish(
        undefined,
        new Error(
          `INTERNAL: the browser did not pick up this code within ${ACK_MS / 1000} s (its connection stalled); it is reconnecting, so run the cell again once`,
        ),
      );
    }, ACK_MS).unref?.();
  }

  /** A browser reconnected: keep running cells alive and let them answer on the new socket. */
  rebind(clientInstanceId: string, socket: WebSocket): void {
    for (const [cellId, cell] of this.cells) {
      if (cell.clientInstanceId !== clientInstanceId) continue;
      if (cell.closeTimer) clearTimeout(cell.closeTimer);
      delete cell.closeTimer;
      cell.socket = socket;
      socket.once("close", () => {
        if (!this.cells.has(cellId)) return;
        cell.closeTimer = setTimeout(() => {
          cell.finish(undefined, new Error("BROWSER_OFFLINE"));
        }, LINK_GRACE_MS);
      });
    }
  }

  handle(candidate: unknown, socket: WebSocket): boolean {
    const kind = (candidate as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string" || !kind.startsWith("browser.code.")) return false;
    const call = BrowserCodeCallSchema.safeParse(candidate);
    if (call.success) this.serve(call.data, socket);
    this.update(candidate, socket);
    return true;
  }

  private update(candidate: unknown, socket: WebSocket): void {
    const progress = BrowserCodeProgressSchema.safeParse(candidate);
    if (progress.success) {
      const cell = this.cells.get(progress.data.cellId);
      if (cell?.socket !== socket) return;
      // Any word from the browser about this cell proves it arrived.
      cell.stage = progress.data.stage ?? (cell.stage === "sent" ? "received" : cell.stage);
      if (progress.data.waitingForUser !== undefined) cell.waiting(progress.data.waitingForUser);
      rememberOpened(cell.opened, progress.data.steps);
      cell.input.onProgress(progress.data.steps);
      return;
    }
    const result = BrowserCodeResultSchema.safeParse(candidate);
    if (!result.success) return this.rejectUnreadable(candidate, result.error, socket);
    const cell = this.cells.get(result.data.cellId);
    if (cell?.socket === socket) cell.finish(withTimeoutWarn(result.data, cell.timeoutWarn));
  }

  /** A result this daemon can't read fails its cell now, with the reason, instead of waiting
   * out the deadline (the extension and the daemon disagree on the message shape). */
  private rejectUnreadable(
    candidate: unknown,
    error: { issues: { message: string }[] },
    socket: WebSocket,
  ): void {
    const message = candidate as { kind?: unknown; cellId?: unknown };
    if (message.kind !== "browser.code.result" || typeof message.cellId !== "string") return;
    const cell = this.cells.get(message.cellId);
    if (cell?.socket !== socket) return;
    const reason = error.issues[0]?.message ?? "bad shape";
    cell.finish(undefined, new Error(`BROWSER_RESULT_INVALID: ${reason}`));
  }

  private serve(
    call: { cellId: string; callId: string; request: unknown },
    socket: WebSocket,
  ): void {
    const cell = this.cells.get(call.cellId);
    if (!cell || cell.socket !== socket) return;
    const { cellId, callId } = call;
    void cell.input.onCall(call.request).then(
      (value) => reply(socket, { kind: "browser.code.reply", cellId, callId, value }),
      (error: unknown) =>
        reply(socket, {
          kind: "browser.code.reply",
          cellId,
          callId,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 20000),
        }),
    );
  }
}

/** Tabs a cell's progress shows it opening, kept so a cell that fails still hands them over. */
function rememberOpened(
  opened: Map<number, BrowserTargetKey>,
  steps: Record<string, unknown>[],
): void {
  for (const step of steps) {
    // attachTab also returns a tab, but it is the user's or another chat's: never adopt it.
    if ((step.action as { op?: unknown } | undefined)?.op !== "openTab") continue;
    const result = step.result as { kind?: unknown; tab?: { target?: unknown } } | undefined;
    if (result?.kind !== "tab") continue;
    const target = BrowserTargetKeySchema.safeParse(result.tab?.target);
    if (target.success) opened.set(target.data.tabId, target.data);
  }
}

function withTimeoutWarn(result: BrowserCodeResult, warn?: string): BrowserCodeResult {
  if (!warn || result.output.startsWith(warn)) return result;
  return { ...result, output: `${warn}${result.output ? `\n${result.output}` : ""}` };
}

function reply(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
