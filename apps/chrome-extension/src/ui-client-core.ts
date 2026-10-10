import {
  DaemonUiRequestSchema,
  DaemonUiResponseSchema,
  type DaemonUiRequest,
  type DaemonUiResponse,
} from "@aeon/protocol";

export type UiConnectResult =
  { kind: "connected"; client: UiClient } | { kind: "failed"; code: string };

export class UiClient {
  readonly history: DaemonUiResponse[] = [];
  private messageCount = 0;
  private historyStart = 0;
  private readonly listeners = new Set<(message: DaemonUiResponse) => void>();
  private readonly waiters = new Set<{
    predicate: (message: DaemonUiResponse) => boolean;
    after: number;
    resolve(message: DaemonUiResponse): void;
    reject(error: Error): void;
    timer: number;
  }>();

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data)) as unknown;
      } catch {
        return;
      }
      const response = DaemonUiResponseSchema.safeParse(parsed);
      if (!response.success) {
        console.error(
          "Invalid daemon response",
          response.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
        );
        return;
      }
      const position = this.messageCount++;
      this.history.push(response.data);
      if (this.history.length > 256) {
        this.history.shift();
        this.historyStart += 1;
      }
      for (const waiter of this.waiters) {
        if (position >= waiter.after && waiter.predicate(response.data)) {
          this.waiters.delete(waiter);
          globalThis.clearTimeout(waiter.timer);
          waiter.resolve(response.data);
        }
      }
      for (const listener of this.listeners) listener(response.data);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.waiters) {
        globalThis.clearTimeout(waiter.timer);
        waiter.reject(new Error("The local Chat connection closed."));
      }
      this.waiters.clear();
    });
  }

  send(candidate: DaemonUiRequest): number {
    const request = DaemonUiRequestSchema.parse(candidate);
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error("The local Chat connection is closed.");
    const position = this.messageCount;
    this.socket.send(JSON.stringify(request));
    return position;
  }

  waitFor(
    predicate: (message: DaemonUiResponse) => boolean,
    after = 0,
    timeoutMs = 8000,
  ): Promise<DaemonUiResponse> {
    const queued = this.history.slice(Math.max(0, after - this.historyStart)).find(predicate);
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        after,
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("The local Chat request timed out."));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  subscribe(listener: (message: DaemonUiResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close();
  }
}
