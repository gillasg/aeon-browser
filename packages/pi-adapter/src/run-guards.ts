import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { freshLoop, noteLoop, type LoopState } from "./loop-detector.js";

const watched = new WeakSet<object>();

export function watchGuards(session: AgentSession): void {
  if (watched.has(session)) return;
  watched.add(session);
  const loop = freshLoop();
  const pending = new Map<string, { tool: string; args: unknown }>();
  session.subscribe((event) => {
    void onGuardEvent(session, event, { loop, pending });
  });
}

/** The steer is delivered before the run stops, so the reason is not dropped. */
export async function deliverStop(
  session: { steer: (text: string) => Promise<unknown> | unknown; abort: () => void },
  reason: string,
): Promise<void> {
  await session.steer(reason);
  session.abort();
}

interface GuardBag {
  loop: LoopState;
  pending: Map<string, { tool: string; args: unknown }>;
}

async function onGuardEvent(
  session: AgentSession,
  event: {
    type: string;
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
  },
  bag: GuardBag,
): Promise<void> {
  if (event.type === "agent_end") {
    bag.loop.recent = [];
    bag.loop.steered = false;
    return;
  }
  if (event.type === "tool_execution_start" && event.toolCallId)
    bag.pending.set(event.toolCallId, { tool: event.toolName ?? "tool", args: event.args });
  if (event.type === "tool_execution_end") await noteTool(session, event, bag);
}

async function noteTool(
  session: AgentSession,
  event: {
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
  },
  bag: GuardBag,
): Promise<void> {
  const start = event.toolCallId ? bag.pending.get(event.toolCallId) : undefined;
  const decision = noteLoop(bag.loop, {
    tool: event.toolName ?? start?.tool ?? "tool",
    args: event.args ?? start?.args,
    error: Boolean(event.isError),
    result: resultText(event.result),
  });
  if (decision.stop) await deliverStop(session, decision.stop);
  else if (decision.steer) void session.steer(decision.steer);
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(result).slice(0, 2000);
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}
