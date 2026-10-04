import { Buffer } from "node:buffer";
import { type PiContentBlock, type PiJsonValue } from "@pippin/domain";
import { compactBrowserResult } from "./browser-result-projection.js";

const MAX_TEXT_CHARS = 24_000;
const MAX_CONTENT_BLOCKS = 64;
const MAX_JSON_DEPTH = 6;
const MAX_OBJECT_KEYS = 40;

export function projectContent(content: string | readonly unknown[]): readonly PiContentBlock[] {
  const blocks: PiContentBlock[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : content
          .map(projectContentBlock)
          .filter((block): block is PiContentBlock => block !== undefined);
  const bounded = blocks.slice(0, MAX_CONTENT_BLOCKS).map(boundContentBlock);
  if (blocks.length > MAX_CONTENT_BLOCKS) {
    bounded.push({
      type: "text",
      text: `[${blocks.length - MAX_CONTENT_BLOCKS} Pi blocks omitted]`,
    });
  }
  return bounded;
}

function projectContentBlock(value: unknown): PiContentBlock | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case "text":
      return projectTextBlock(block);
    case "thinking":
      return projectThinkingBlock(block);
    case "image":
      return projectImageBlock(block);
    case "toolCall":
      return projectToolCallBlock(block);
    default:
      return undefined;
  }
}

function projectTextBlock(block: Record<string, unknown>): PiContentBlock | undefined {
  return typeof block.text === "string" ? { type: "text", text: block.text } : undefined;
}

function projectThinkingBlock(block: Record<string, unknown>): PiContentBlock | undefined {
  if (typeof block.thinking !== "string") return undefined;
  return {
    type: "thinking",
    text: block.thinking,
    ...(typeof block.redacted === "boolean" ? { redacted: block.redacted } : {}),
  };
}

function projectImageBlock(block: Record<string, unknown>): PiContentBlock | undefined {
  if (typeof block.data !== "string") return undefined;
  return {
    type: "image",
    mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
    byteLength: Buffer.byteLength(block.data, "base64"),
  };
}

function projectToolCallBlock(block: Record<string, unknown>): PiContentBlock | undefined {
  if (typeof block.id !== "string" || typeof block.name !== "string") return undefined;
  return {
    type: "tool-call",
    toolCallId: block.id,
    toolName: block.name,
    arguments: safeJsonObject(block.arguments),
  };
}

function boundContentBlock(block: PiContentBlock): PiContentBlock {
  if (block.type === "text" || block.type === "thinking") {
    const bounded = boundString(block.text);
    return { ...block, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) };
  }
  if (block.type === "tool-call") {
    return { ...block, arguments: safeJsonObject(block.arguments) };
  }
  return block;
}

export function safeJsonObject(value: unknown): { readonly [key: string]: PiJsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const output: Record<string, PiJsonValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = toJsonValue(item, 0);
  }
  if (Object.keys(value).length > MAX_OBJECT_KEYS) output._omitted = "key-limit";
  return output;
}

function toJsonValue(value: unknown, depth: number): PiJsonValue {
  if (depth >= MAX_JSON_DEPTH) return "[omitted: depth limit]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundString(value).text;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value))
    return value.slice(0, MAX_OBJECT_KEYS).map((item) => toJsonValue(item, depth + 1));
  if (typeof value === "object") return safeJsonObjectAtDepth(value, depth + 1);
  return `[omitted: ${typeof value}]`;
}

function safeJsonObjectAtDepth(
  value: object,
  depth: number,
): { readonly [key: string]: PiJsonValue } {
  const output: Record<string, PiJsonValue> = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  for (const [key, item] of entries) output[key] = toJsonValue(item, depth);
  if (Object.keys(value).length > MAX_OBJECT_KEYS) output._omitted = "key-limit";
  return output;
}

export function resultText(value: unknown): string {
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { content?: unknown }).content;
    if (typeof content === "string") return truncateText(content);
    if (Array.isArray(content)) {
      return truncateText(
        content
          .map((item) => {
            if (typeof item !== "object" || item === null || !("type" in item)) return "";
            const block = item as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string") return block.text;
            if (block.type === "image") return "[image omitted from trace payload]";
            return "";
          })
          .filter(Boolean)
          .join("\n"),
      );
    }
  }
  try {
    return truncateText(JSON.stringify(toJsonValue(value, 0)));
  } catch {
    return "[Pi result omitted]";
  }
}

export function truncateText(value: string): string {
  const bounded = boundString(value);
  return bounded.text;
}

function boundString(value: string): { text: string; truncated: boolean } {
  if (value.length > MAX_TEXT_CHARS) {
    const browserResult = compactBrowserResult(value, MAX_TEXT_CHARS);
    if (browserResult) return { text: browserResult, truncated: true };
  }
  return value.length <= MAX_TEXT_CHARS
    ? { text: value, truncated: false }
    : { text: `${value.slice(0, MAX_TEXT_CHARS)}\n[truncated]`, truncated: true };
}
