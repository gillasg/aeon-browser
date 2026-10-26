import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CdpServer, type CdpTab } from "@browserkit/cdp";

// The daemon's own CDP endpoint. It uses the same server and adapter contract as browserkit's
// bridge, but every call travels to the extension through the executor socket Aeon already has.
// Tabs opened by a CDP client belong to that client and close with it.

export interface CdpInfo {
  running: true;
  port: number;
  token: string;
  url: string;
  connectUrl: string;
  wsUrl: string;
}

interface Waiter {
  resolve(message: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpService {
  private server: CdpServer | undefined;
  private info: CdpInfo | undefined;
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly send: (body: Record<string, unknown>) => void,
    private readonly directory: string,
  ) {}

  get running(): boolean {
    return Boolean(this.server && this.info);
  }

  async start(port: number): Promise<CdpInfo> {
    if (this.server && this.info) return this.info;
    const token = randomBytes(24).toString("base64url");
    const server = new CdpServer(token, {
      openTab: (session, url) => this.openTab(session, url),
      closeTab: (session, tabId) => this.closeTab(session, tabId),
      command: (session, tabId, method, params, engineSessionId) =>
        this.command(session, tabId, method, params, engineSessionId),
    });
    const bound = await server.start(Math.max(0, Math.min(port, 65535)));
    this.server = server;
    this.info = {
      running: true,
      port: bound,
      token,
      url: server.url,
      connectUrl: `${server.url}?token=${token}`,
      wsUrl: server.wsUrl,
    };
    await writeFile(join(this.directory, "cdp.json"), JSON.stringify(this.info, null, 2)).catch(
      () => undefined,
    );
    return this.info;
  }

  async status(): Promise<CdpInfo | { running: false }> {
    if (this.info) return this.info;
    try {
      const saved = JSON.parse(await readFile(join(this.directory, "cdp.json"), "utf8")) as {
        port?: number;
        token?: string;
      };
      if (!saved.port || !saved.token) return { running: false };
      const reply = await fetch(
        `http://127.0.0.1:${saved.port}/json/version?token=${encodeURIComponent(saved.token)}`,
        { signal: AbortSignal.timeout(800) },
      );
      if (!reply.ok) return { running: false };
      const info = {
        running: true as const,
        port: saved.port,
        token: saved.token,
        url: `http://127.0.0.1:${saved.port}`,
        connectUrl: `http://127.0.0.1:${saved.port}?token=${saved.token}`,
        wsUrl: String(
          ((await reply.json()) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl ?? "",
        ),
      };
      this.info = info;
      return info;
    } catch {
      return { running: false };
    }
  }

  async stop(): Promise<{ running: false }> {
    await this.server?.stop().catch(() => undefined);
    this.server = undefined;
    this.info = undefined;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP endpoint stopped"));
    }
    this.waiters.clear();
    await unlink(join(this.directory, "cdp.json")).catch(() => undefined);
    return { running: false };
  }

  /** Replies and debugger events from the extension. */
  handle(candidate: unknown): boolean {
    if (!candidate || typeof candidate !== "object") return false;
    const message = candidate as Record<string, unknown>;
    if (message.kind === "cdp.event" || message.kind === "cdp.detached") {
      this.server?.handleEngine(message);
      return true;
    }
    if (message.kind !== "cdp.result" && message.kind !== "cdp.tab") return false;
    const waiter = this.waiters.get(String(message.id ?? ""));
    if (!waiter) return true;
    this.waiters.delete(String(message.id ?? ""));
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(String(message.error)));
    else waiter.resolve(message);
    return true;
  }

  private openTab(session: string, url: string): Promise<CdpTab> {
    return this.request({ kind: "cdp.newTab", chatId: session, url }).then((reply) => {
      const tab = reply.tab as Record<string, unknown> | undefined;
      const target = (tab?.target ?? {}) as Record<string, unknown>;
      if (!tab || !reply.targetId) throw new Error("Could not open a tab");
      return {
        tabId: Number(target.tabId ?? tab.tabId),
        targetId: String(reply.targetId),
        url: String(tab.url ?? url),
        title: String(tab.title ?? ""),
      };
    });
  }

  private async closeTab(session: string, tabId: number): Promise<void> {
    await this.request({ kind: "cdp.closeTab", chatId: session, tabId });
  }

  private async command(
    session: string,
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    engineSessionId?: string,
  ): Promise<unknown> {
    const reply = await this.request({
      kind: "cdp.command",
      chatId: session,
      tabId,
      method,
      params,
      ...(engineSessionId ? { sessionId: engineSessionId } : {}),
    });
    return reply.result ?? {};
  }

  private request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("CDP command timed out"));
      }, 30_000);
      this.waiters.set(id, { resolve, reject, timer });
      try {
        this.send({ ...body, id });
      } catch (error) {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
