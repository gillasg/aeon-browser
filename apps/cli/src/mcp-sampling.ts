import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aeonDataDirectory } from "@aeon/location";

// MCP sampling: when an outside agent declares the sampling capability, Aeon can answer its own
// model calls with that agent's model. No Aeon model key is needed. The CLI's MCP server owns the
// one bridge in this process, so every AeonClient (the MCP server's and the CLI host's) sees it.

export type Json = Record<string, unknown>;

export interface SamplingCapabilities {
  sampling: boolean;
  tools: boolean;
}

export interface ModelContext {
  systemPrompt: string;
  messages: unknown[];
  tools: unknown[];
}

export interface ModelResult {
  content: { type: string; text?: string; id?: string; name?: string; arguments?: unknown }[];
  [key: string]: unknown;
}

/** Plain and short: an outside agent's refusal is never dressed up as an Aeon model failure. */
export const DECLINED = "your agent declined the model request";
const CANCELLED = "MCP_REQUEST_CANCELLED: the model request was cancelled.";
const MAX_TOKENS = 8192;

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CLIENT_INFO = "io.modelcontextprotocol/clientInfo";

/** A client that declares `capabilities.sampling` can answer createMessage; `sampling.tools` is tool use. */
export function readSamplingCapabilities(params: unknown): SamplingCapabilities {
  const envelope = isRecord(params) ? params : {};
  const meta = isRecord(envelope._meta) ? envelope._meta : {};
  const info = isRecord(meta[CLIENT_INFO]) ? (meta[CLIENT_INFO] as Json) : {};
  // Classic clients declare it in initialize.capabilities; the 2026-07-28 era carries it in _meta.
  for (const candidate of [envelope.capabilities, meta.capabilities, info.capabilities]) {
    if (!isRecord(candidate)) continue;
    const sampling = candidate.sampling;
    if (isRecord(sampling) || sampling === true)
      return { sampling: true, tools: isRecord(sampling) && Object.hasOwn(sampling, "tools") };
  }
  if (isRecord(meta.sampling) || meta.sampling === true)
    return {
      sampling: true,
      tools: isRecord(meta.sampling) && Object.hasOwn(meta.sampling, "tools"),
    };
  return { sampling: false, tools: false };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part)) {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .join("\n");
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}

/** Pi messages (including toolResult turns) become plain sampling text, never more than the local call. */
export function toSamplingMessages(messages: unknown[]): Json[] {
  return messages.flatMap((value) => {
    if (!isRecord(value)) return [{ role: "user", content: { type: "text", text: textOf(value) } }];
    const role = value.role === "assistant" ? "assistant" : "user";
    const text = textOf(value.content);
    const labelled =
      value.role === "toolResult"
        ? `Tool ${String(value.toolName ?? "call")} result: ${text}`
        : text;
    return [{ role, content: { type: "text", text: labelled } }];
  });
}

export function toSamplingTools(tools: unknown[]): Json[] {
  return tools.flatMap((value) => {
    if (!isRecord(value) || typeof value.name !== "string") return [];
    return [
      {
        name: value.name,
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        inputSchema: isRecord(value.parameters) ? value.parameters : { type: "object" },
      },
    ];
  });
}

export function fromSamplingResult(result: Json): ModelResult {
  const raw = Array.isArray(result.content) ? result.content : [];
  const content: ModelResult["content"] = [];
  for (const value of raw) {
    if (!isRecord(value)) continue;
    if (value.type === "text") {
      content.push({ type: "text", text: typeof value.text === "string" ? value.text : "" });
    } else if (value.type === "tool_use") {
      content.push({
        type: "toolCall",
        id: typeof value.id === "string" ? value.id : randomUUID(),
        name: typeof value.name === "string" ? value.name : "",
        arguments: isRecord(value.input) ? value.input : {},
      });
    }
  }
  return {
    content,
    ...(typeof result.stopReason === "string" ? { stopReason: result.stopReason } : {}),
  };
}

export class SamplingBridge {
  private capabilities: SamplingCapabilities = { sampling: false, tools: false };
  private useClientModel = false;
  private sender: ((request: Json) => void) | undefined;
  private warnedNoTools = false;
  private readonly pending = new Map<string, Pending>();

  learnCapabilities(params: unknown): void {
    const learned = readSamplingCapabilities(params);
    // A declaration only ever adds sampling; a request without one never turns it off.
    if (learned.sampling) this.capabilities = learned;
  }

  setUseClientModel(value: boolean): void {
    this.useClientModel = value;
  }

  setSender(sender: (request: Json) => void): void {
    this.sender = sender;
  }

  /** Route model calls only when the client offered sampling and the user's condition holds. */
  get active(): boolean {
    return this.capabilities.sampling && this.useClientModel;
  }

  get supportsTools(): boolean {
    return this.capabilities.tools;
  }

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** A notifications/cancelled for one of our createMessage requests stops that call. */
  abort(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.finish(id, entry);
    entry.reject(new Error(CANCELLED));
    return true;
  }

  /** True when the message answers one of our requests (and it was delivered there). */
  receive(id: string, message: Json): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.finish(id, entry);
    const error = message.error;
    if (isRecord(error) || message.isError === true) {
      entry.reject(new Error(DECLINED));
      return true;
    }
    if (!isRecord(message.result)) {
      entry.reject(new Error(DECLINED));
      return true;
    }
    const result = message.result;
    if (result.isError === true || isRecord(result.error)) {
      entry.reject(new Error(DECLINED));
      return true;
    }
    try {
      entry.resolve({ message: fromSamplingResult(result) });
    } catch {
      entry.reject(new Error(DECLINED));
    }
    return true;
  }

  async complete(context: ModelContext, timeoutMs: number, signal?: AbortSignal): Promise<Json> {
    const withTools = (context.tools?.length ?? 0) > 0 && this.supportsTools;
    if (!withTools && (context.tools?.length ?? 0) > 0 && !this.warnedNoTools) {
      this.warnedNoTools = true;
      process.stderr.write("Aeon: your agent's model cannot call tools here; using text only.\n");
    }
    const id = randomUUID();
    const request: Json = {
      jsonrpc: "2.0",
      id,
      method: "sampling/createMessage",
      params: {
        messages: toSamplingMessages(context.messages ?? []),
        systemPrompt: typeof context.systemPrompt === "string" ? context.systemPrompt : "",
        maxTokens: MAX_TOKENS,
        ...(withTools ? { tools: toSamplingTools(context.tools) } : {}),
      },
    };
    return new Promise<Json>((resolve, reject) => {
      const entry: Pending = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      const finish = () => this.finish(id, entry);
      const onAbort = () => {
        finish();
        reject(new Error(CANCELLED));
      };
      entry.onAbort = onAbort;
      entry.timer = setTimeout(() => {
        finish();
        reject(new Error(DECLINED));
      }, timeoutMs);
      this.pending.set(id, entry);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.sender?.(request);
      } catch {
        finish();
        reject(new Error(DECLINED));
      }
    });
  }

  /** Abandon every outstanding request when the client's stdio stream closes. */
  close(): void {
    for (const id of [...this.pending.keys()]) this.abort(id);
    this.sender = undefined;
  }

  private finish(id: string, entry: Pending): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    if (this.pending.get(id) === entry) this.pending.delete(id);
  }
}

const CONFIG_FILE = "mcp-sampling.json";
const ENV_OVERRIDE = "AEON_MCP_USE_CLIENT_MODEL";

export function samplingConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(aeonDataDirectory({ env }), CONFIG_FILE);
}

export async function readUseClientModel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env[ENV_OVERRIDE] === "1" || env[ENV_OVERRIDE] === "true") return true;
  try {
    const parsed: unknown = JSON.parse(await readFile(samplingConfigPath(env), "utf8"));
    return isRecord(parsed) && parsed.mcpUseClientModel === true;
  } catch {
    return false;
  }
}

export async function writeUseClientModel(
  value: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = samplingConfigPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ mcpUseClientModel: value })}\n`, { mode: 0o600 });
}

let bridge: SamplingBridge | undefined;

/** Install the process-wide sampling bridge (only the MCP server does). */
export function setSamplingBridge(value: SamplingBridge | undefined): void {
  if (bridge && bridge !== value) bridge.close();
  bridge = value;
}

export function getSamplingBridge(): SamplingBridge | undefined {
  return bridge;
}
