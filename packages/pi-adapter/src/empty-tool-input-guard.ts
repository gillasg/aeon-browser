import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// A model can emit a tool call with no arguments at all (`codemode {}`). For a tool whose one
// input is a string (a grammar tool such as codemode), the provider then refuses to replay that
// call on every later turn ("requires argument code to be a string") and the whole run fails.
// Give the missing input an empty string: the tool runs, reports the empty input as its own
// error, and the model gets a normal turn to make the call again.

interface ToolShape {
  name: string;
  parameters?: unknown;
}

/** The single required string property of a tool's parameters, when it has exactly one. */
export function singleStringInput(parameters: unknown): string | undefined {
  const schema = parameters as {
    type?: unknown;
    required?: unknown;
    properties?: Record<string, { type?: unknown }>;
  } | null;
  if (!schema || schema.type !== "object" || !Array.isArray(schema.required)) return undefined;
  if (schema.required.length !== 1 || typeof schema.required[0] !== "string") return undefined;
  const key = schema.required[0];
  return schema.properties?.[key]?.type === "string" ? key : undefined;
}

/** The message with each missing string input filled with "", or undefined when nothing was missing. */
export function fillMissingStringInputs(
  message: AssistantMessage,
  tools: readonly ToolShape[],
): AssistantMessage | undefined {
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "toolCall") return block;
    const key = singleStringInput(tools.find((tool) => tool.name === block.name)?.parameters);
    const args = (block.arguments ?? {}) as Record<string, unknown>;
    if (!key || typeof args[key] === "string") return block;
    changed = true;
    return { ...block, arguments: { ...args, [key]: "" } };
  });
  return changed ? ({ ...message, content } as AssistantMessage) : undefined;
}

export function emptyToolInputGuard(): InlineExtension {
  return {
    name: "empty-tool-input-guard",
    factory: (pi) => {
      pi.on("message_end", (event): { message: AssistantMessage } | undefined => {
        if (event.message.role !== "assistant") return undefined;
        const message = event.message as AssistantMessage;
        if (!message.content.some((block) => block.type === "toolCall")) return undefined;
        const fixed = fillMissingStringInputs(message, pi.getAllTools());
        return fixed ? { message: fixed } : undefined;
      });
    },
  };
}
