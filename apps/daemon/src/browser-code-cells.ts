import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  BrowserCodeCallSchema,
  BrowserCodeProgressSchema,
  BrowserCodeResultSchema,
  BrowserCodeRunSchema,
  type BrowserCodeResult,
  type BrowserTargetKey,
} from "@aeon/protocol";

export interface BrowserCodeCellInput {
  code: string;
  timeoutMs: number;
  ownerTitle?: string;
  /** Where this cell's tabs go unless a step chooses; decided from the chat's origin. */
  space?: "window" | "tabs";
  /** Human-verification assistance is only for cells the user started. */
  challengeAssist?: boolean;
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
}

const LINK_GRACE_MS = 60_000;

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
        // Only this cell fails: its variables and tabs stay for the next cell.
        cancel(false);
        finish(
          undefined,
          new Error(
            "Browser code exceeded its deadline; that cell stopped, and its variables and tabs are still there.",
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
        finish(undefined, new Error("Browser workflow cancelled; runtime reset"));
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
        } else reject(error ?? new Error("OPERATION_FAILED"));
      };
      this.cells.set(cellId, { clientInstanceId, socket, input, finish, waiting });
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("close", close);
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
            ...(input.challengeAssist ? { challengeAssist: true } : {}),
          }),
        ),
      );
    });
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
      if (progress.data.waitingForUser !== undefined) cell.waiting(progress.data.waitingForUser);
      cell.input.onProgress(progress.data.steps);
      return;
    }
    const result = BrowserCodeResultSchema.safeParse(candidate);
    if (!result.success) return;
    const cell = this.cells.get(result.data.cellId);
    if (cell?.socket === socket) cell.finish(result.data);
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
