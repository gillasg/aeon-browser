import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol/version";
import { aeonDataDirectory } from "@aeon/location";
import WebSocket from "ws";
import { getSamplingBridge } from "./mcp-sampling.js";
import { notRunningMessage, readStartFailure } from "./start-failure.js";

// One connection to the running Aeon daemon through its local Core endpoint. The daemon writes
// the endpoint and a fresh token to core-connection.json in its data folder each time it starts.
type Json = Record<string, unknown>;

// A request the daemon does not recognise is dropped without a reply (for example a tool name
// added to a newer CLI than the daemon supports). Every wait is bounded and names the operation so
// an ignored request never hangs the CLI forever and the error says what to do about it.
const CONNECT_TIMEOUT_MS = 15_000;
function noReply(what: string): Error {
  return new Error(
    `Aeon did not answer ${what}. It may be running an older version that ignores this request; update Aeon and retry.`,
  );
}
export interface AttentionChat {
  chatId: string;
  working: boolean;
  completionId: string | null;
}

export function dataDirectory(): string {
  return aeonDataDirectory();
}

/**
 * A daemon that was just updated closes an old client with `UPDATE_REQUIRED:<version>`. Say what
 * the gap is and the exact step to reconnect, instead of leaving the user at a bare close code.
 */
export function connectionCloseMessage(code: number, reason: string): string {
  const daemon = /^UPDATE_REQUIRED:(\d+\.\d+)/.exec(reason)?.[1];
  if (daemon && code === 1008)
    return (
      `This Aeon command speaks protocol ${SUPPORTED_PROTOCOL_VERSION.major}.${SUPPORTED_PROTOCOL_VERSION.minor}; the running daemon speaks ${daemon}. ` +
      "Update Aeon so the command, the daemon and the extension are the same build, then reload the extension in chrome://extensions and retry the command."
    );
  if (reason === "UPDATE_REQUIRED")
    return (
      `This Aeon command does not match the running daemon. ` +
      "Update Aeon so the command, the daemon and the extension are the same build, then reload the extension in chrome://extensions and retry the command."
    );
  return `Aeon closed the connection (${code} ${reason}).`;
}

export class AeonClient {
  private readonly waiting = new Map<string, (message: Json) => void>();
  private readonly attentionListeners = new Set<(chats: AttentionChat[]) => void>();
  private openWaiters = new Map<string, (reply: Json) => void>();
  private lastChats: { working?: boolean; asking?: unknown }[] = [];
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
      throw new Error(notRunningMessage(await readStartFailure()));
    }
    const socket = new WebSocket(state.endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", () => reject(new Error("Could not reach the Aeon daemon.")));
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(noReply("the connection handshake")),
        CONNECT_TIMEOUT_MS,
      );
      socket.once("message", (raw) => {
        clearTimeout(timer);
        const message = JSON.parse(String(raw)) as Json;
        if (message.kind === "core.ready") resolve();
        else reject(new Error("Aeon refused the connection."));
      });
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(connectionCloseMessage(code, String(reason))));
      });
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
  tool(body: Json, timeoutMs = 11 * 60_000, signal?: AbortSignal): Promise<Json> {
    const requestId = randomUUID();
    const what = `the ${String(body.tool ?? "tool")} request`;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiting.delete(requestId);
      };
      const timer = setTimeout(() => {
        finish();
        reject(noReply(what));
      }, timeoutMs);
      // A 2026-07-28 notifications/cancelled stops waiting on this reply. The call is not retried.
      const onAbort = () => {
        finish();
        reject(new Error("MCP_REQUEST_CANCELLED: the tool call was cancelled."));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.tool.result") return;
        finish();
        resolve(message);
      });
      if (signal?.aborted) return;
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
    body: { code: string; session: string; timeoutMs?: number; browser?: string },
    timeoutMs = 11 * 60_000,
  ): Promise<Json> {
    const requestId = randomUUID();
    // A cell asked to run longer than the default still gets its own time plus a minute.
    const wait = Math.max(timeoutMs, (body.timeoutMs ?? 0) + 60_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("The browser did not answer in time. Update Aeon and retry."));
      }, wait);
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

  /**
   * One tool-calling completion for the AI commands. In an MCP session that offered sampling (and
   * has no Aeon model, or asked to prefer the agent's), the calling agent's model answers instead.
   */
  modelComplete(
    body: { systemPrompt: string; messages: unknown[]; tools: unknown[] },
    timeoutMs = 5 * 60_000,
    signal?: AbortSignal,
  ): Promise<Json> {
    const sampler = getSamplingBridge();
    if (sampler?.active) return sampler.complete(body, timeoutMs, signal);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiting.delete(requestId);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("The model did not answer in time."));
      }, timeoutMs);
      const onAbort = () => {
        finish();
        reject(new Error("MCP_REQUEST_CANCELLED: the model request was cancelled."));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(requestId, (message) => {
        if (message.kind !== "core.model.result") return;
        finish();
        resolve(message);
      });
      if (signal?.aborted) return;
      this.socket.send(JSON.stringify({ kind: "core.model.complete", requestId, ...body }));
    });
  }

  /** One request with its own reply kind (core.browsers, core.chat.pin). */
  private ask(kind: string, body: Json, replyKind: string, timeoutMs = 15_000): Promise<Json> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("Aeon did not answer in time. Update Aeon if this keeps happening."));
      }, timeoutMs);
      this.waiting.set(requestId, (message) => {
        if (message.kind !== replyKind) return;
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(message);
      });
      this.socket.send(JSON.stringify({ kind, requestId, ...body }));
    });
  }

  /** The app-level health ping: daemon, extension and engine, not a socket ping. */
  health(timeoutMs = 2500): Promise<Json> {
    return this.ask("core.health", {}, "core.health.result", timeoutMs);
  }

  /** Chats, routines, cells and abilities still running. Older daemons never answer this. */
  activity(timeoutMs = 1500): Promise<{ idle: boolean; busy: string[] }> {
    return this.ask("core.activity", {}, "core.activity.result", timeoutMs).then((message) => ({
      idle: message.idle === true,
      busy: Array.isArray(message.busy)
        ? message.busy.filter((item): item is string => typeof item === "string")
        : [],
    }));
  }

  /** The latest attention snapshot, for an update that is talking to an older daemon. */
  snapshotChats(): { working?: boolean; asking?: unknown }[] {
    return this.lastChats;
  }

  /** Lists the connected browsers (one per Chrome profile), naming one first if asked. */
  browsers(rename?: { browser: string; name: string }): Promise<Json> {
    return this.ask("core.browsers", rename ? { rename } : {}, "core.browsers.result");
  }

  /** Keeps a chat in the named browser: its tab opens and its steps run only there. */
  async pinChat(chatId: string, browser: string): Promise<void> {
    const reply = await this.ask("core.chat.pin", { chatId, browser }, "core.chat.pinned");
    if (reply.ok !== true) throw new Error(String(reply.error ?? `Could not use ${browser}.`));
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
  openChat(chatId: string, active = false, timeoutMs = 30_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openWaiters.delete(chatId);
        reject(noReply("the open-chat request"));
      }, timeoutMs);
      this.openWaiters.set(chatId, (reply) => {
        clearTimeout(timer);
        resolve(Number(reply.browsers));
      });
      this.socket.send(JSON.stringify({ kind: "core.chat.open", chatId, active }));
    });
  }

  /**
   * Opens the chat's tab and types the prompt into its composer on camera; resolves once it is
   * typed. The caller still submits the prompt (it is never the user's own typing).
   */
  openTypedChat(
    chatId: string,
    prompt: string,
    timeoutMs = 30_000,
  ): Promise<{ typed: boolean; recording: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openWaiters.delete(chatId);
        reject(noReply("the typed-chat request"));
      }, timeoutMs);
      this.openWaiters.set(chatId, (reply) => {
        clearTimeout(timer);
        resolve({
          typed: reply.typed === true,
          recording: reply.recording === true,
          ...(typeof reply.error === "string" ? { error: reply.error } : {}),
        });
      });
      this.socket.send(JSON.stringify({ kind: "core.chat.open", chatId, typed: prompt }));
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
    budget?: { maxSteps?: number; maxMinutes?: number; maxCost?: number },
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
          payload: { chatId, text, selection, ...(budget ? { budget } : {}) },
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
      this.lastChats = Array.isArray(message.chats)
        ? (message.chats as { working?: boolean; asking?: unknown }[])
        : [];
      for (const listener of this.attentionListeners) listener(message.chats as AttentionChat[]);
      return;
    }
    if (message.kind === "core.chat.opened") {
      const chatId = String(message.chatId);
      this.openWaiters.get(chatId)?.(message);
      this.openWaiters.delete(chatId);
      return;
    }
    if (typeof message.requestId === "string") this.waiting.get(message.requestId)?.(message);
  }
}
