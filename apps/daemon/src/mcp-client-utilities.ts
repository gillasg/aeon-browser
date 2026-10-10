import { createHash } from "node:crypto";
import { fromJsonSchema, type Tool } from "@modelcontextprotocol/client";
import type { McpCapability } from "@aeon/domain";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SERVER_TOOLS = 128;
const MAX_TOOL_SCHEMA_BYTES = 64_000;
const MAX_TOOL_DEFINITION_BYTES = 16_000;
const MAX_OUTPUT_BYTES = 32_000;

export function boundedTools(tools: Tool[]): Tool[] {
  const selected: Tool[] = [];
  let totalBytes = 0;
  for (const tool of tools.slice(0, MAX_SERVER_TOOLS)) {
    if (!tool.name || typeof tool.name !== "string" || !isRecord(tool.inputSchema)) continue;
    const size = Buffer.byteLength(JSON.stringify(tool), "utf8");
    if (size > MAX_TOOL_DEFINITION_BYTES || totalBytes + size > MAX_TOOL_SCHEMA_BYTES) break;
    totalBytes += size;
    selected.push(tool);
  }
  return selected;
}

export function capabilitySignature(capability: McpCapability): string {
  return hash({
    transport: capability.transport,
    command: capability.command,
    args: capability.args,
    endpoint: capability.endpoint,
    workingDirectory: capability.workingDirectory,
    credentialReference: capability.credentialReference,
  });
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateArguments(
  schema: Tool["inputSchema"],
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let validation: Awaited<ReturnType<ReturnType<typeof fromJsonSchema>["~standard"]["validate"]>>;
  try {
    validation = await fromJsonSchema(schema as Parameters<typeof fromJsonSchema>[0])[
      "~standard"
    ].validate(args);
  } catch {
    throw new Error("MCP_SCHEMA_INVALID: the advertised input schema could not be validated.");
  }
  if (!("value" in validation) || !isRecord(validation.value))
    throw new Error("MCP_ARGUMENT_INVALID: arguments do not match the advertised input schema.");
  return validation.value;
}

export function boundedString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function boundValue(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return value;
  return {
    truncated: true,
    excerpt: Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8"),
  };
}
