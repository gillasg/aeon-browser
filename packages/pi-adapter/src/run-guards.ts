import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { unaskedIrreversible } from "@browserkit/engine/official-form";
import {
  absorbReads,
  freshAnswer,
  noteAnswer,
  seededText,
  type AnswerState,
} from "./answer-check.js";
import { freshLoop, noteLoop, type LoopState } from "./loop-detector.js";
import { noteSteer, taskOf } from "./task-context.js";

const watched = new WeakSet<object>();

export function watchGuards(session: AgentSession, chatId: string): void {
  if (watched.has(session)) return;
  watched.add(session);
  const loop = freshLoop();
  const answers = freshAnswer();
  let announced = false;
  const pending = new Map<string, { tool: string; args: unknown }>();
  session.subscribe((event) => {
    void onGuardEvent(session, chatId, event, {
      loop,
      answers,
      pending,
      announced: () => announced,
      markAnnounced: () => {
        announced = true;
      },
      resetAnnounce: () => {
        announced = false;
      },
    });
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
  answers: AnswerState;
  pending: Map<string, { tool: string; args: unknown }>;
  announced: () => boolean;
  markAnnounced: () => void;
  resetAnnounce: () => void;
}

async function onGuardEvent(
  session: AgentSession,
  chatId: string,
  event: {
    type: string;
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
    message?: unknown;
  },
  bag: GuardBag,
): Promise<void> {
  if (event.type === "agent_end") {
    bag.loop.recent = [];
    bag.loop.steered = false;
    bag.answers.reads.clear();
    bag.answers.steered = false;
    bag.resetAnnounce();
    return;
  }
  if (event.type === "tool_execution_start" && event.toolCallId)
    bag.pending.set(event.toolCallId, { tool: event.toolName ?? "tool", args: event.args });
  if (event.type === "tool_execution_end") await noteTool(session, chatId, event, bag);
  if (event.type === "message_end") noteMessage(session, chatId, event.message, bag);
}

async function noteTool(
  session: AgentSession,
  chatId: string,
  event: {
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
  },
  bag: GuardBag,
): Promise<void> {
  absorbSeed(chatId, bag.answers);
  const start = event.toolCallId ? bag.pending.get(event.toolCallId) : undefined;
  const result = resultText(event.result);
  const decision = noteLoop(bag.loop, {
    tool: event.toolName ?? start?.tool ?? "tool",
    args: event.args ?? start?.args,
    error: Boolean(event.isError),
    result,
  });
  if (!event.isError) absorbReads(bag.answers, result, event.toolCallId ?? "");
  if (decision.stop) {
    await deliverStop(session, decision.stop);
    return;
  }
  if (decision.steer) void session.steer(decision.steer);
}

function absorbSeed(chatId: string, answers: AnswerState): void {
  const text = seededText(chatId);
  if (text) absorbReads(answers, text, "prompt");
}

function noteMessage(session: AgentSession, chatId: string, message: unknown, bag: GuardBag): void {
  absorbSeed(chatId, bag.answers);
  const record = message as { role?: string; content?: unknown } | undefined;
  if (record?.role === "user") {
    const text = contentText(record.content);
    if (!text.trim()) return;
    noteSteer(chatId, text);
    absorbReads(bag.answers, text, "prompt");
    return;
  }
  const text = answerText(message);
  if (!text) return;
  const answer = noteAnswer(bag.answers, text);
  if (answer.steer) void session.steer(answer.steer);
  if (bag.announced()) return;
  const announced = unaskedIrreversible(taskOf(chatId), text);
  if (!announced) return;
  bag.markAnnounced();
  void session.steer(announced);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

function answerText(message: unknown): string {
  const record = message as { role?: string; content?: unknown } | undefined;
  if (!record || record.role !== "assistant") return "";
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  if (record.content.some((block) => isToolBlock(block))) return "";
  return record.content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

function isToolBlock(block: unknown): boolean {
  const type = block && typeof block === "object" ? (block as { type?: unknown }).type : "";
  return type === "toolCall" || type === "tool_use";
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
