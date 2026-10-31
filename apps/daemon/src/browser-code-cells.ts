import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  BrowserCodeCallSchema,
  BrowserCodeProgressSchema,
  BrowserCodeResultSchema,
  BrowserCodeRunSchema,
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
}

const LINK_GRACE_MS = 60_000;
/** A browser answers a run at once; silence past this means the connection stalled. */
const ACK_MS = 10_000;

/** Runs browser_code cells inside a connected executor: one round trip per cell, not per step. */
export class BrowserCodeCells {
  private readonly cells = new Map<string, Pending>();
  constructor(private readonly adopt: (chatId: string, target: BrowserTargetKey) => void) {}

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
      const expire = () => {
        const stage = this.cells.get(cellId)?.stage ?? "sent";
        // A realm that never began evaluating cannot be trusted: drop it so the next cell starts
        // clean. A cell that was evaluating keeps its variables, as before.
        const neverEvaluated =
          stage === "sent" ||
          stage === "received" ||
          stage === "offscreen" ||
          stage === "realm-ready";
        cancel(neverEvaluated);
        finish(
          undefined,
          new Error(
            `${neverEvaluated ? "INTERNAL: the browser never started this code; " : "TIMEOUT: "}browser code exceeded its deadline (last stage: ${stage}); that cell stopped, and its variables and tabs ${neverEvaluated ? "were reset" : "are still there"}.`,
          ),
        );
      };
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
        expire,
        input.timeoutMs + 5000,
      );
      const waiting = (paused: boolean) => {
        clearTimeout(timer);
        timer = paused ? undefined : setTimeout(expire, input.timeoutMs + 5000);
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
        clearTimeout(timer);
        if (cell?.closeTimer) clearTimeout(cell.closeTimer);
        signal?.removeEventListener("abort", abort);
        if (cell) cell.socket.off("close", close);
        if (result) {
          for (const target of result.opened) this.adopt(chatId, target);
          resolve(result);
        } else reject(error ?? new Error("INTERNAL: the cell ended without a result"));
      };
      this.cells.set(cellId, {
        clientInstanceId,
        socket,
        input,
        finish,
        waiting,
        stage: "sent",
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
            timeoutMs: input.timeoutMs,
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
      cell.input.onProgress(progress.data.steps);
      return;
    }
    const result = BrowserCodeResultSchema.safeParse(candidate);
    if (!result.success) return this.rejectUnreadable(candidate, result.error, socket);
    const cell = this.cells.get(result.data.cellId);
    if (cell?.socket === socket) cell.finish(result.data);
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

function reply(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
