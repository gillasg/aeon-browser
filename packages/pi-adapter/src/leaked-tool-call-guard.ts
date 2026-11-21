import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// DeepSeek (opencode-go) sometimes writes its tool call as text instead of a tool call. Pi then
// ends the run and that text becomes the chat's answer (DSML: `<｜DSML｜ invoke name="…">`).
// Turn the leaked markup back into the call the model meant to make, before the answer is shown.
// Pi 1.6.0 has no parser for this format and no setting to turn one on, so the fix is here: a
// message_end handler can replace the finalized message in place, and the agent loop then
// executes any toolCall blocks it finds in that same message.

const BAR = "[|｜]";
const INVOKE_PATTERN = `<${BAR}\\s*DSML\\s*${BAR}\\s*invoke\\s+([^>]*)>([\\s\\S]*?)<\\/${BAR}\\s*DSML\\s*${BAR}\\s*invoke\\s*>`;
const INVOKE = new RegExp(INVOKE_PATTERN, "gi");
const INVOKE_TEST = new RegExp(INVOKE_PATTERN, "i");
const PARAMETER = new RegExp(
  `<${BAR}\\s*DSML\\s*${BAR}\\s*parameter\\s+([^>]*)>([\\s\\S]*?)<\\/${BAR}\\s*DSML\\s*${BAR}\\s*parameter\\s*>`,
  "gi",
);
// Other models use the same idea with a single bar or a different token (Qwen's <|tool▁calls…|>).
const TOOL_MARKUP =
  /<[|｜][^>\n]{0,60}(?:calls|invoke|tool_call|tool_calls|function_call|function|recipient|tool)[^>\n]{0,60}[|｜]>/i;

export interface ParsedCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** True when text carries tool-call markup that must never be shown as an answer. */
export function hasLeakedToolCallMarkup(text: string): boolean {
  return TOOL_MARKUP.test(text) || INVOKE_TEST.test(text);
}

function decode(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return match ? (match[1] ?? match[2]) : undefined;
}

function parseParameter(attrs: string, value: string): [string, unknown] | undefined {
  const key = attribute(attrs, "name");
  if (!key) return undefined;
  const raw = decode(value.trim());
  if (attribute(attrs, "string") === "true") return [key, raw];
  try {
    return [key, JSON.parse(raw)];
  } catch {
    return [key, raw];
  }
}

/** Parse the DSML `<invoke>/<parameter>` blocks a model wrote as text. */
export function parseLeakedToolCalls(text: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  for (const block of text.matchAll(INVOKE)) {
    const name = attribute(block[1] ?? "", "name");
    if (!name?.trim()) continue;
    const args: Record<string, unknown> = {};
    for (const parameter of (block[2] ?? "").matchAll(PARAMETER)) {
      const parsed = parseParameter(parameter[1] ?? "", parameter[2] ?? "");
      if (parsed) args[parsed[0]] = parsed[1];
    }
    calls.push({ name: name.trim(), arguments: args });
  }
  return calls;
}

const CORRECTION =
  "Your last answer was a tool call written as text. Do not write tool calls in the answer. Make the call with the tool instead, with the same code.";
const LEAK_NOTICE = "The model returned a tool call as text; I could not run that step.";

export function leakedToolCallGuard(): InlineExtension {
  let sequence = 0;
  let rePrompted = false;
  return {
    name: "leaked-tool-call-guard",
    factory: (pi) => {
      pi.on("agent_start", () => {
        rePrompted = false;
        return undefined;
      });
      pi.on("message_end", (event): { message: AssistantMessage } | undefined => {
        if (event.message.role !== "assistant") return undefined;
        const message = event.message as AssistantMessage;
        const leaking = (block: (typeof message.content)[number]) =>
          block.type === "text" && hasLeakedToolCallMarkup(block.text);
        if (!message.content.some(leaking)) return undefined;
        const kept = message.content.filter((block) => !leaking(block));
        const leaked = message.content.filter(leaking);
        const calls = leaked.flatMap((block) =>
          block.type === "text" ? parseLeakedToolCalls(block.text) : [],
        );
        if (calls.length) {
          const toolCalls = calls.map((call, index) => ({
            type: "toolCall" as const,
            id: `leaked-${Date.now()}-${sequence++}-${index}`,
            name: call.name,
            arguments: call.arguments,
          }));
          return {
            message: {
              ...message,
              content: [...kept, ...toolCalls],
              stopReason: "toolUse",
            } as AssistantMessage,
          };
        }
        // Unknown markup: it still must not be the answer. Strip it and give the model one more
        // turn to make a real call; after that, say what happened instead of looping.
        if (!rePrompted) {
          rePrompted = true;
          pi.sendUserMessage(CORRECTION, { deliverAs: "steer" });
        }
        return {
          message: {
            ...message,
            content: kept.length ? kept : [{ type: "text", text: LEAK_NOTICE }],
          } as AssistantMessage,
        };
      });
    },
  };
}
