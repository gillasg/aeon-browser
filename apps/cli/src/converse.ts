import type { AeonClient } from "./client.js";
import { summarize, type TraceStep } from "./results.js";
import { chooseModel } from "./run.js";

// Talking to a chat that already exists: send it another message, answer what its agent asked,
// and wait for something to change. Outside agents (CLI and MCP) use these; nothing here counts
// as the user typing, so a message sent this way never lifts a site block.
type Json = Record<string, unknown>;

/** A question the chat's agent is waiting on (ask_user and other dialogs). */
export interface Question {
  questionId: string;
  kind: "select" | "confirm" | "input" | "editor";
  question: string;
  detail: string | null;
  choices: string[];
  placeholder: string | null;
  expiresAt: string;
}

export interface ChatState {
  chatId: string;
  working: boolean;
  /** Steps (tool calls) so far: pass it back as `since` to see only what is new. */
  steps: number;
  newSteps: TraceStep[];
  questions: Question[];
  /** The latest answer, once the chat is idle. */
  answer?: string;
}

interface Dialog {
  requestId: string;
  kind: Question["kind"];
  title: string;
  message: string | null;
  options: string[];
  placeholder: string | null;
  expiresAt: string;
}

export async function questions(client: AeonClient, chatId: string): Promise<Question[]> {
  const result = await client.command("chat.pi-ui", { chatId });
  const dialogs = ((result.piUi as { extensionDialogs?: Dialog[] } | undefined)?.extensionDialogs ??
    []) as Dialog[];
  return dialogs.map((dialog) => ({
    questionId: dialog.requestId,
    kind: dialog.kind,
    question: dialog.title,
    detail: dialog.message,
    choices: dialog.options,
    placeholder: dialog.placeholder,
    expiresAt: dialog.expiresAt,
  }));
}

/** Answers the agent's question (the only one, or `questionId`); yes/no for confirm, a choice or its number for select. */
export async function answer(
  client: AeonClient,
  chatId: string,
  reply: string,
  questionId?: string,
): Promise<{ answered: string; question: string }> {
  const pending = await questions(client, chatId);
  const question = questionId ? pending.find((item) => item.questionId === questionId) : pending[0];
  if (!question)
    throw new Error(
      questionId
        ? `No pending question ${questionId} in that chat.`
        : "The chat is not waiting on a question.",
    );
  const value = answerValue(question, reply);
  const result = await client.command("chat.extension-ui-answer", {
    chatId,
    dialogRequestId: question.questionId,
    value,
  });
  if (result.accepted === false)
    throw new Error("Aeon did not accept the answer (it may have expired).");
  return { answered: String(value), question: question.question };
}

function answerValue(question: Question, reply: string): string | boolean {
  const text = reply.trim();
  if (question.kind === "confirm") {
    if (/^(y|yes|true|ok|confirm)$/i.test(text)) return true;
    if (/^(n|no|false|cancel)$/i.test(text)) return false;
    throw new Error(`"${question.question}" needs yes or no.`);
  }
  if (question.kind !== "select") return reply;
  const byNumber = /^\d+$/.test(text) ? question.choices[Number(text) - 1] : undefined;
  const choice =
    byNumber ?? question.choices.find((item) => item.toLowerCase() === text.toLowerCase());
  if (!choice)
    throw new Error(
      `Pick one of: ${question.choices.map((item, i) => `${i + 1}. ${item}`).join(", ")}`,
    );
  return choice;
}

/**
 * Sends another message into the chat. While it runs, the message waits as a follow-up (or
 * steers the current turn); when idle, it starts a new turn with the chat's own model.
 */
export async function send(
  client: AeonClient,
  chatId: string,
  text: string,
  options: { steer?: boolean } = {},
): Promise<{ mode: "sent" | "followUp" | "steer" }> {
  const reply = await client.command("chat.controls", { chatId });
  const controls = reply.controls as {
    active: boolean;
    effectiveModel: { provider: string; id: string } | null;
    thinkingLevel: string;
  } | null;
  if (controls?.active) {
    const mode = options.steer ? "steer" : "followUp";
    await client.command("chat.queue", { chatId, mode, text });
    return { mode };
  }
  const selection = controls?.effectiveModel
    ? {
        model: { provider: controls.effectiveModel.provider, id: controls.effectiveModel.id },
        thinkingLevel: controls.thinkingLevel,
      }
    : await chooseModel(client, {});
  await client.submit(chatId, text, selection);
  return { mode: "sent" };
}

/** The chat now: whether it works, its steps after `since`, its questions and its answer. */
export async function chatState(client: AeonClient, chatId: string, since = 0): Promise<ChatState> {
  const [view, pending] = await Promise.all([
    client.command("chat.get", { chatId }),
    questions(client, chatId),
  ]);
  const snapshot = view.snapshot as Json;
  const working = snapshot.runState !== "idle";
  const result = summarize(chatId, "", snapshot, 0, "finished");
  return {
    chatId,
    working,
    steps: result.trace.length,
    newSteps: result.trace.slice(since),
    questions: pending,
    ...(working ? {} : { answer: result.answer }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until something changes: a step after `since`, a question, or the chat going idle.
 * Returns at once when one already holds, and with `changed: false` after the timeout.
 */
export async function waitForChange(
  client: AeonClient,
  chatId: string,
  options: { since?: number; timeoutMs: number },
): Promise<ChatState & { changed: boolean }> {
  const deadline = Date.now() + options.timeoutMs;
  // Without `since`, only steps from now on count.
  let since = options.since;
  for (;;) {
    const state = await chatState(client, chatId, since ?? Number.MAX_SAFE_INTEGER);
    since ??= state.steps;
    const changed = state.newSteps.length > 0 || state.questions.length > 0 || !state.working;
    if (changed || Date.now() >= deadline) return { ...state, changed };
    await sleep(1000);
  }
}
