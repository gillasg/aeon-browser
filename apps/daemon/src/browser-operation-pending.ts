import type { BrowserExecutorRequest, BrowserExecutorResult } from "@aeon/protocol";
import type { WebSocket } from "ws";
export interface BrowserPending {
  chatId: string;
  socket: WebSocket;
  operationId: string;
  finish(result?: BrowserExecutorResult, code?: string, detail?: string): void;
  timer: NodeJS.Timeout;
}
export function sendBrowserRequest(
  pendingRequests: Map<string, BrowserPending>,
  socket: WebSocket,
  request: BrowserExecutorRequest,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }> {
  return new Promise((resolve) => {
    const finish = (result?: BrowserExecutorResult, code?: string, detail?: string) => {
      const pending = pendingRequests.get(request.requestId);
      if (!pending) return;
      pendingRequests.delete(request.requestId);
      clearTimeout(pending.timer);
      resolve(
        result ? { result } : { code: code ?? "BROWSER_OFFLINE", ...(detail ? { detail } : {}) },
      );
    };
    const timer = setTimeout(() => {
      finish(undefined, "TIMEOUT");
      onTimeout();
    }, timeoutMs);
    pendingRequests.set(request.requestId, {
      chatId: request.chatId,
      socket,
      operationId: request.operationId,
      finish,
      timer,
    });
    socket.send(JSON.stringify(request), (error) => {
      if (error) finish(undefined, "BROWSER_OFFLINE");
    });
  });
}
