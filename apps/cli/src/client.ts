import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";
import WebSocket from "ws";

// One connection to the running Aeon daemon through its local Core endpoint. The daemon writes
// the endpoint and a fresh token to core-connection.json in its data folder each time it starts.
type Json = Record<string, unknown>;
export interface AttentionChat {
  chatId: string;
  working: boolean;
  completionId: string | null;
}

export function dataDirectory(): string {
  if (process.env.AEON_DATA_DIR) return process.env.AEON_DATA_DIR;
  const local = process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", "AppData", "Local");
  return join(local, "Aeon", "data");
}

export class AeonClient {
  private readonly waiting = new Map<string, (message: Json) => void>();
  private readonly attentionListeners = new Set<(chats: AttentionChat[]) => void>();
  private openWaiters = new Map<string, (browsers: number) => void>();
  private pinger: ReturnType<typeof setInterval> | undefined;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => this.receive(JSON.parse(String(raw)) as Json));
  }

  static async connect(): Promise<AeonClient> {
    const file = join(dataDirectory(), "core-connection.json");
    let state: { endpoint: string; token: string };
    try {
      state = JSON.parse(await readFile(file, "utf8")) as { endpoint: string; token: string };
    } catch {
      throw new Error(
        "Aeon is not running. Open Chrome with Aeon loaded (the daemon starts with it), then retry.",
      );
    }
    const socket = new WebSocket(state.endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", () => reject(new Error("Could not reach the Aeon daemon.")));
    });
    const ready = new Promise<void>((resolve, reject) => {
      socket.once("message", (raw) => {
        const message = JSON.parse(String(raw)) as Json;
        if (message.kind === "core.ready") resolve();
        else reject(new Error("Aeon refused the connection."));
      });
      socket.once("close", (code, reason) =>
        reject(new Error(`Aeon closed the connection (${code} ${String(reason)}).`)),
      );
    });
    socket.send(
      JSON.stringify({
        kind: "core.hello",
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        clientId: randomUUID(),
        surface: "cli",
        token: state.token,
      }),
    );
    await ready;
    const client = new AeonClient(socket);
    client.socket.send(JSON.stringify({ kind: "core.attention.watch" }));
    // Liveness: the daemon answers pings, so long waits are never mistaken for a dead daemon.
    client.pinger = setInterval(
      () => client.socket.send(JSON.stringify({ kind: "ping", requestId: randomUUID() })),
      15_000,
    );
    return client;
  }

  /** Sends one command and resolves with its completed result, or rejects with its failure. */
  command(operation: string, payload: Json): Promise<Json> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      // Aeon drops requests it can't parse (e.g. a limit over 100) without a reply.
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error(`Aeon did not answer ${operation}; check its inputs.`));
      }, 30000);
      this.waiting.set(requestId, (message) => {
        clearTimeout(timer);
        if (message.kind === "command.completed") resolve(message.result as Json);
        else if (message.kind === "command.failed" || message.state === "failed")
          reject(new Error(String(message.message ?? message.code ?? "Aeon command failed")));
        else return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
      });
      this.socket.send(JSON.stringify({ kind: "command", requestId, operation, payload }));
    });
  }

  /** Lists Aeon's chat tools for outside agents, or calls one in a named session. */
  tool(body: Json, timeoutMs = 11 * 60_000): Promise<Json> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("Aeon did not answer in time. Update Aeon if this keeps happening."));
      }, timeoutMs);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.tool.result") return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ ...body, requestId }));
    });
  }

  /** Reads (no `set`) or changes the agent settings; one entry per connected Chrome. */
  settings(set: Json | undefined, timeoutMs = 15_000): Promise<Json[]> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("Aeon did not answer in time. Update Aeon if this keeps happening."));
      }, timeoutMs);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.settings.result") return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve((message.browsers as Json[] | undefined) ?? []);
      });
      this.socket.send(
        JSON.stringify({ kind: "core.settings", requestId, ...(set ? { set } : {}) }),
      );
    });
  }

  /** Runs browser code in the user's Chrome and returns the cell's own value and output. */
  browserRun(
    body: { code: string; session: string; timeoutMs?: number },
    timeoutMs = 11 * 60_000,
  ): Promise<Json> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("The browser did not answer in time. Update Aeon and retry."));
      }, timeoutMs);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.browser.result") return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ kind: "core.browser.run", requestId, ...body }));
    });
  }

  /** Starts, reports or stops the daemon's DevTools endpoint. */
  cdp(
    body: { action: "start" | "status" | "stop"; port?: number },
    timeoutMs = 20_000,
  ): Promise<Json> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("Aeon did not answer the CDP request in time."));
      }, timeoutMs);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.cdp.result") return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ kind: "core.cdp", requestId, ...body }));
    });
  }

  /** One tool-calling completion with Aeon's default model (the AI commands use this). */
  modelComplete(
    body: { systemPrompt: string; messages: unknown[]; tools: unknown[] },
    timeoutMs = 5 * 60_000,
  ): Promise<Json> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("The model did not answer in time."));
      }, timeoutMs);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.model.result") return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ kind: "core.model.complete", requestId, ...body }));
    });
  }

  /** Reads or changes the sites agents may not use (the extension's settings list). */
  blocked(body: { action: "read" | "add" | "remove"; site?: string }): Promise<Json> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("Aeon did not answer in time. Update Aeon if this keeps happening."));
      }, 15_000);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.blocked-sites.result") return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ kind: "core.blocked-sites", requestId, ...body }));
    });
  }

  /** Shows a chat as a tab in the connected Chrome; resolves with how many browsers were asked. */
  openChat(chatId: string, active = false): Promise<number> {
    return new Promise((resolve) => {
      this.openWaiters.set(chatId, resolve);
      this.socket.send(JSON.stringify({ kind: "core.chat.open", chatId, active }));
    });
  }

  /** Stops a running chat; the daemon tidies its tabs. */
  stop(chatId: string): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("Aeon did not stop the chat in time."));
      }, 30_000);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.chat.stopped") return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        if (message.stopped !== true)
          reject(new Error(String(message.error ?? "Aeon could not stop that chat.")));
        else resolve(true);
      });
      this.socket.send(JSON.stringify({ kind: "core.chat.stop", requestId, chatId }));
    });
  }

  /**
   * Sends a Chat's first prompt through the daemon, the same path its tab uses: no tab has to
   * open, and the prompt does not depend on one finishing loading. Resolves once the daemon
   * starts the run; rejects when it refuses or cannot start Pi.
   */
  submit(
    chatId: string,
    text: string,
    selection: { model: { provider: string; id: string }; thinkingLevel: string },
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("Aeon did not start the prompt; check the model and try again."));
      }, 30_000);
      this.waiting.set(requestId, (message) => {
        const started = message.kind === "command.started";
        const failed =
          message.kind === "command.failed" ||
          (message.kind === "command.settled" && message.state === "failed");
        if (!started && !failed) return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        if (failed)
          reject(new Error(String(message.message ?? message.code ?? "Aeon could not submit.")));
        else resolve();
      });
      this.socket.send(
        JSON.stringify({
          kind: "command",
          requestId,
          operation: "chat.submit",
          payload: { chatId, text, selection },
        }),
      );
    });
  }

  onAttention(listener: (chats: AttentionChat[]) => void): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  close(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.socket.close();
  }

  private receive(message: Json): void {
    if (message.kind === "core.attention.snapshot") {
      for (const listener of this.attentionListeners) listener(message.chats as AttentionChat[]);
      return;
    }
    if (message.kind === "core.chat.opened") {
      const chatId = String(message.chatId);
      this.openWaiters.get(chatId)?.(Number(message.browsers));
      this.openWaiters.delete(chatId);
      return;
    }
    if (typeof message.requestId === "string") this.waiting.get(message.requestId)?.(message);
  }
}
