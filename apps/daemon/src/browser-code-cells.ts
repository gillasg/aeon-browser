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
  onCall: (request: unknown) => Promise<unknown>;
  onProgress: (steps: Record<string, unknown>[]) => void;
}
interface Pending {
  socket: WebSocket;
  input: BrowserCodeCellInput;
  finish: (result?: BrowserCodeResult, error?: Error) => void;
}

/** Runs browser_code cells inside a connected executor: one round trip per cell, not per step. */
export class BrowserCodeCells {
  private readonly cells = new Map<string, Pending>();
  constructor(private readonly adopt: (chatId: string, target: BrowserTargetKey) => void) {}

  run(
    socket: WebSocket,
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
      const timer = setTimeout(() => {
        cancel(true);
        finish(undefined, new Error("Browser code exceeded its deadline; runtime reset"));
      }, input.timeoutMs + 5000);
      const abort = () => {
        cancel(true);
        finish(undefined, new Error("Browser workflow cancelled; runtime reset"));
      };
      const close = () => finish(undefined, new Error("BROWSER_OFFLINE"));
      const finish = (result?: BrowserCodeResult, error?: Error) => {
        if (!this.cells.delete(cellId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.off("close", close);
        if (result) {
          for (const target of result.opened) this.adopt(chatId, target);
          resolve(result);
        } else reject(error ?? new Error("OPERATION_FAILED"));
      };
      this.cells.set(cellId, { socket, input, finish });
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
          }),
        ),
      );
    });
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
      if (cell?.socket === socket) cell.input.onProgress(progress.data.steps);
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
