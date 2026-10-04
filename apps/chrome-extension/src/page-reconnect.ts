import type { DevUiClient } from "./dev-ui-client.js";

/** Retries connections and read-only initialization; never replays submitted commands. */
export class PageReconnect {
  private timer: number | undefined;
  private attempt = 0;
  private busy = false;
  private stopped = false;
  private watched: DevUiClient | undefined;
  constructor(
    private readonly connect: () => Promise<void>,
    private readonly onFailure: (message: string) => void,
  ) {
    window.addEventListener("pagehide", () => this.stop(), { once: true });
    window.addEventListener("online", () => this.wake());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.wake();
    });
  }
  async start(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.connect();
    } catch (error) {
      this.onFailure(error instanceof Error ? error.message : "Could not connect to Aeon.");
      this.schedule();
    } finally {
      this.busy = false;
    }
  }
  watch(client: DevUiClient): void {
    this.watched = client;
    this.attempt = 0;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const disconnected = () => {
      if (this.stopped || this.watched !== client) return;
      this.watched = undefined;
      this.onFailure("Connection lost · reconnecting…");
      this.schedule();
    };
    client.socket.addEventListener("close", disconnected, { once: true });
    if (client.socket.readyState !== WebSocket.OPEN) disconnected();
  }
  private wake(): void {
    if (this.watched?.socket.readyState === WebSocket.OPEN || this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    void this.start();
  }
  private schedule(): void {
    if (this.stopped || this.timer !== undefined) return;
    const delay = Math.min(250 * 2 ** Math.min(this.attempt++, 3), 2000);
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      void this.start();
    }, delay);
  }
  private stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
