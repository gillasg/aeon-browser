import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { asActivationId, asChatId, type PiBrowserContextRecord } from "@aeon/domain";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  type TranscriptContext,
} from "@earendil-works/pi-ai/utils/transcript";
import { browserContextPrompt } from "./browser-context-message.js";
import { captureFixtureModelRequest } from "./fixture-model.js";
import { PiSdkSessionAdapter } from "./session-adapter.js";

/**
 * A fixed page record so the first-turn context is a template, not a live tab.
 * `browserContextPrompt` is the same function a chat uses when a page is attached.
 */
export const AGENT_SURFACE_PAGE: PiBrowserContextRecord = {
  contextId: "00000000-0000-4000-8000-000000000010",
  kind: "page",
  capturedAt: "2026-01-01T00:00:00.000Z",
  target: {
    clientInstanceId: "00000000-0000-4000-8000-000000000011",
    browserRunId: "00000000-0000-4000-8000-000000000012",
    tabId: 0,
    tabIncarnation: "00000000-0000-4000-8000-000000000013",
  },
  url: "https://example.test/page",
  title: "Page title",
};

const NEW_CHAT_PROMPT = "New chat.";

export interface AgentSurfaceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentSurface {
  systemPrompt: string;
  tools: AgentSurfaceTool[];
  firstTurn: string;
  hash: string;
}

export interface AgentSurfacePaths {
  workingDirectory: string;
  agentDirectory: string;
  sessionDirectory: string;
}

/**
 * What a new chat's first model request contains: the system prompt, the tool
 * declarations on that request, and the page-context template. Opens a session
 * the same way the daemon does (fixture model, no network, no daemon).
 */
export async function buildAgentSurface(paths: AgentSurfacePaths): Promise<AgentSurface> {
  await Promise.all([
    mkdir(paths.workingDirectory, { recursive: true }),
    mkdir(paths.agentDirectory, { recursive: true }),
    mkdir(paths.sessionDirectory, { recursive: true }),
  ]);
  const surface = readSurface(await captureNewChat(paths));
  return { ...surface, hash: hashAgentSurface(surface) };
}

// Machine paths (a checkout's node_modules, the export's workspace) are not part of what the model
// is told to do: the hash leaves them out so one build hashes the same in every checkout.
const MODULES_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`]*?node_modules/g;
const WORKSPACE_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`]*?agent-surface[\\/]+workspace/g;

export function hashAgentSurface(surface: Omit<AgentSurface, "hash">): string {
  const portable = stableJson(surface)
    .replace(MODULES_PATH, "<node_modules>")
    .replace(WORKSPACE_PATH, "<workspace>");
  return createHash("sha256").update(portable).digest("hex");
}

async function captureNewChat(paths: AgentSurfacePaths): Promise<TranscriptContext> {
  let first: TranscriptContext | undefined;
  const stop = captureFixtureModelRequest((context) => {
    first ??= context;
  });
  const adapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
    testModel: "local-faux",
    browserGuidance: true,
    fixtureToolAllowlist: false,
  });
  try {
    const session = await adapter.openOrCreate({
      chatId: asChatId(randomUUID()),
      activationId: asActivationId(randomUUID()),
      workingDirectory: paths.workingDirectory,
      reference: null,
      materialized: false,
    });
    await session
      .submit({ text: NEW_CHAT_PROMPT, browserContext: AGENT_SURFACE_PAGE })
      .catch((error: unknown) => {
        if (!first) throw error;
      });
  } finally {
    stop();
    await adapter.closeAll();
  }
  if (!first) throw new Error("The fixture model did not receive a request.");
  return first;
}

function readSurface(context: TranscriptContext): Omit<AgentSurface, "hash"> {
  const firstTurn = browserContextPrompt(AGENT_SURFACE_PAGE);
  if (!requestTexts(context.messages).includes(firstTurn))
    throw new Error("The first model request did not include the first-turn context.");
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages).map(declareTool),
    firstTurn,
  };
}

function declareTool(tool: Parameters<typeof toToolDeclaration>[0]): AgentSurfaceTool {
  const declared = toToolDeclaration(tool);
  return {
    name: declared.name,
    description: declared.description,
    parameters: schemaOf(declared.parameters),
  };
}

function schemaOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("A tool parameter schema was not an object.");
  return value as Record<string, unknown>;
}

function requestTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
  return messages.flatMap((message) => {
    const text = blockText(message.content);
    return text ? [text] : [];
  });
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(textBlock)
    .filter((text) => text.length > 0)
    .join("\n");
}

function textBlock(block: unknown): string {
  if (typeof block !== "object" || block === null || !("text" in block)) return "";
  const text = block.text;
  return typeof text === "string" ? text : "";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  const body = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
  return `{${body.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
