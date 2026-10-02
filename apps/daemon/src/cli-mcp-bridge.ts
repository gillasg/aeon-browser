import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliCapability } from "@pippin/domain";
import { parseRegistry } from "./capability-parsing.js";
import {
  HELP_TIMEOUT_MS,
  MAX_ARGUMENTS,
  MAX_ARGUMENT_LENGTH,
  RUN_TIMEOUT_MS,
  readArguments,
  resolveRegisteredExecutable,
  runRegisteredCli,
} from "./cli-mcp-process.js";

const VERSION = "1.0.0";
const TOOL_DEFINITIONS = [
  {
    name: "cli_catalog",
    description: "List only the CLI capabilities explicitly registered in Aeon.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cli_help",
    description: "Run the fixed --help probe for one explicitly registered CLI.",
    inputSchema: {
      type: "object",
      properties: { capabilityId: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["capabilityId"],
      additionalProperties: false,
    },
  },
  {
    name: "cli_run",
    description:
      "Run an explicitly registered non-interactive CLI with separate argv items and its registered cwd. Output is bounded and commands time out after 30 seconds; login and TUI flows are unsupported.",
    inputSchema: {
      type: "object",
      properties: {
        capabilityId: { type: "string", minLength: 1, maxLength: 64 },
        args: {
          type: "array",
          maxItems: MAX_ARGUMENTS,
          items: { type: "string", maxLength: MAX_ARGUMENT_LENGTH },
        },
      },
      required: ["capabilityId"],
      additionalProperties: false,
    },
  },
] as const;

type RequestId = string | number;
type JsonRecord = Record<string, unknown>;

export function startCliMcpBridge(registryPath: string): void {
  let activeCliCommand = false;
  const pending = new Map<RequestId, AbortController>();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    void handleLine(
      line,
      registryPath,
      pending,
      () => activeCliCommand,
      (value) => {
        activeCliCommand = value;
      },
    );
  });
  input.on("close", () => {
    for (const controller of pending.values()) controller.abort();
  });
}

async function handleLine(
  line: string,
  registryPath: string,
  pending: Map<RequestId, AbortController>,
  isCliCommandActive: () => boolean,
  setCliCommandActive: (active: boolean) => void,
): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (isRecord(message) && isRequestId(message.id))
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32600, message: "Invalid request" },
      });
    return;
  }
  if (handleNotification(message, pending)) return;
  if (!isRequestId(message.id)) return;
  const id = message.id;
  try {
    const result = await dispatchRequest(
      message,
      id,
      registryPath,
      pending,
      isCliCommandActive,
      setCliCommandActive,
    );
    if (result === METHOD_NOT_FOUND) return;
    writeMessage({ jsonrpc: "2.0", id, result });
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: safeError(error) },
    });
  }
}

async function callTool(
  name: string,
  args: JsonRecord,
  registryPath: string,
  signal: AbortSignal,
  isCliCommandActive: () => boolean,
  setCliCommandActive: (active: boolean) => void,
): Promise<JsonRecord> {
  if (name === "cli_catalog") {
    const capabilities = await readRegisteredCliCapabilities(registryPath);
    return textResult(
      JSON.stringify(
        capabilities.map(({ id, displayName, description, launcher, verification }) => ({
          id,
          displayName,
          description,
          executable: launcher.executable,
          workingDirectory: launcher.workingDirectory,
          verification,
        })),
      ) ?? "null",
    );
  }
  if (name !== "cli_help" && name !== "cli_run")
    return textResult(`Unknown CLI bridge tool '${name}'.`, true);
  const capabilityId = readString(args.capabilityId, "capabilityId", 64);
  const capability = (await readRegisteredCliCapabilities(registryPath)).find(
    (candidate) => candidate.id === capabilityId,
  );
  if (!capability) return textResult(`CLI capability '${capabilityId}' is not registered.`, true);
  if (isCliCommandActive())
    return textResult("Another registered CLI command is already running.", true);
  const commandArgs = name === "cli_help" ? ["--help"] : readArguments(args.args);
  const executable = resolveRegisteredExecutable(
    capability.launcher.executable,
    capability.launcher.workingDirectory,
  );
  const workingDirectory = resolve(capability.launcher.workingDirectory ?? process.cwd());
  setCliCommandActive(true);
  try {
    const result = await runRegisteredCli({
      executable,
      args: commandArgs,
      workingDirectory,
      timeoutMs: name === "cli_help" ? HELP_TIMEOUT_MS : RUN_TIMEOUT_MS,
      signal,
    });
    return textResult(JSON.stringify({ capabilityId, ...result }) ?? "null", cliFailed(result));
  } finally {
    setCliCommandActive(false);
  }
}

async function readRegisteredCliCapabilities(registryPath: string): Promise<CliCapability[]> {
  const parsed = parseRegistry(await readFile(registryPath, "utf8"));
  return parsed.capabilities.filter(
    (capability): capability is CliCapability => capability.kind === "cli",
  );
}

function textResult(text: string, isError = false): JsonRecord {
  return { content: [{ type: "text", text }], isError };
}

function writeMessage(message: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : "CLI bridge request failed.";
  return text.replace(/[\r\n\0]/g, " ").slice(0, 300);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function readString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new Error(`${name} is invalid.`);
  return value.trim();
}

async function main(): Promise<void> {
  const registryFlag = process.argv.indexOf("--registry");
  const registryPath = registryFlag >= 0 ? process.argv[registryFlag + 1] : undefined;
  if (!registryPath) throw new Error("--registry requires an explicit registry path.");
  startCliMcpBridge(resolve(registryPath));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

const METHOD_NOT_FOUND = Symbol("method-not-found");
async function dispatchRequest(
  message: JsonRecord,
  id: RequestId,
  registryPath: string,
  pending: Map<RequestId, AbortController>,
  isCliCommandActive: () => boolean,
  setCliCommandActive: (active: boolean) => void,
): Promise<unknown> {
  let result: unknown;
  if (message.method === "initialize") {
    const params = isRecord(message.params) ? message.params : {};
    result = {
      protocolVersion:
        typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "pippin-cli", version: VERSION },
    };
  } else if (message.method === "ping") {
    result = {};
  } else if (message.method === "tools/list") {
    result = { tools: TOOL_DEFINITIONS };
  } else if (message.method === "tools/call") {
    result = await dispatchToolCall(
      message,
      id,
      registryPath,
      pending,
      isCliCommandActive,
      setCliCommandActive,
    );
  } else if (message.method === "resources/list") {
    result = { resources: [] };
  } else if (message.method === "prompts/list") {
    result = { prompts: [] };
  } else {
    writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${String(message.method).slice(0, 120)}` },
    });
    return METHOD_NOT_FOUND;
  }

  return result;
}

async function dispatchToolCall(
  message: JsonRecord,
  id: RequestId,
  registryPath: string,
  pending: Map<RequestId, AbortController>,
  isCliCommandActive: () => boolean,
  setCliCommandActive: (active: boolean) => void,
): Promise<unknown> {
  const params = isRecord(message.params) ? message.params : {};
  if (typeof params.name !== "string") throw new Error("A CLI bridge tool name is required.");
  const args = isRecord(params.arguments) ? params.arguments : {};
  const controller = new AbortController();
  pending.set(id, controller);
  try {
    return await callTool(
      params.name,
      args,
      registryPath,
      controller.signal,
      isCliCommandActive,
      setCliCommandActive,
    );
  } finally {
    pending.delete(id);
  }
}

function cliFailed(result: {
  cancelled: boolean;
  timedOut: boolean;
  exitCode: number | null;
}): boolean {
  return result.cancelled || result.timedOut || result.exitCode !== 0;
}

function handleNotification(
  message: JsonRecord,
  pending: Map<RequestId, AbortController>,
): boolean {
  if (message.method === "notifications/initialized") return true;
  if (message.method === "notifications/cancelled") {
    const params = isRecord(message.params) ? message.params : {};
    if (isRequestId(params.requestId)) pending.get(params.requestId)?.abort();
    return true;
  }
  return false;
}
