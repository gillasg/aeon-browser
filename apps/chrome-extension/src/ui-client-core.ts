import {
  DaemonUiRequestSchema,
  DaemonUiResponseSchema,
  type DaemonUiRequest,
  type DaemonUiResponse,
} from "@aeon/protocol";

export type UiConnectResult =
  { kind: "connected"; client: UiClient } | { kind: "failed"; code: string };

// Requests wait for their answer for as long as the daemon is alive: work such as starting a Pi
// session can take seconds. Liveness is checked separately with pings while anything is waiting,
// so only a daemon that stops answering ends a request early.
const PING_EVERY_MS = 10_000;
const MAX_WAIT_MS = 600_000;

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

  private pingTimer: number | undefined;
  private awaitingPong: string | undefined;

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data)) as unknown;
      } catch {
        return;
      }
      // Any message proves the daemon is alive.
      this.awaitingPong = undefined;
      const response = DaemonUiResponseSchema.safeParse(parsed);
      if (!response.success) {
        console.error(
          "Invalid daemon response",
          response.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
        );
        return;
      }
      if (response.data.kind === "pong") return;
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
      if (!this.waiters.size) this.stopPinging();
      for (const listener of this.listeners) listener(response.data);
    });
    socket.addEventListener("close", () => {
      this.stopPinging();
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
    timeoutMs = MAX_WAIT_MS,
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
          if (!this.waiters.size) this.stopPinging();
          reject(new Error("The local Chat request timed out."));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      this.startPinging();
    });
  }

  private startPinging(): void {
    if (this.pingTimer !== undefined) return;
    this.pingTimer = globalThis.setInterval(() => this.ping(), PING_EVERY_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer !== undefined) globalThis.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.awaitingPong = undefined;
  }

  /** A daemon that answers nothing, not even the previous ping, for a whole interval is gone. */
  private ping(): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.awaitingPong) {
      this.socket.close(4008, "Daemon stopped answering");
      return;
    }
    const requestId = crypto.randomUUID();
    this.awaitingPong = requestId;
    this.socket.send(JSON.stringify(DaemonUiRequestSchema.parse({ kind: "ping", requestId })));
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
