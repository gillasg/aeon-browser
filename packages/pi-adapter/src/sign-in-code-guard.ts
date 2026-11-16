import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { SignInCodes } from "./sign-in-codes.js";

// The extension scrubs a code it typed itself. A code the model read off the page (an inbox, a
// split box) is still in the tool result, and the answer is written here, outside that scrub.
// Remember those codes and take them out of the answer. The result the model acts on stays.

type AnswerBlock = TextContent | ThinkingContent | ToolCall;

export function signInCodeGuard(): InlineExtension {
  const codes = new SignInCodes();
  return {
    name: "sign-in-codes",
    factory: (pi) => {
      pi.on("tool_result", (event) => {
        noteResult(codes, event.content, event.structuredContent);
        return undefined;
      });
      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return undefined;
        return maskAnswer(codes, event.message);
      });
    },
  };
}

function noteResult(
  codes: SignInCodes,
  content: readonly { type?: string; text?: string }[],
  structured: unknown,
): void {
  for (const block of content) if (block.type === "text" && block.text) codes.note(block.text);
  if (structured !== undefined) codes.note(JSON.stringify(structured));
}

function maskAnswer(
  codes: SignInCodes,
  message: AssistantMessage,
): { message: AssistantMessage } | undefined {
  let changed = false;
  const content = message.content.map((block) => {
    const next = maskBlock(codes, block);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? { message: { ...message, content } } : undefined;
}

function maskBlock(codes: SignInCodes, block: AnswerBlock): AnswerBlock {
  if (block.type === "text") {
    const text = codes.mask(block.text);
    return text === block.text ? block : { ...block, text };
  }
  if (block.type === "thinking") {
    const thinking = codes.mask(block.thinking);
    return thinking === block.thinking ? block : { ...block, thinking };
  }
  return block;
}
