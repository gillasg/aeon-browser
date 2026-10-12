// Turns a finished chat's view into what a caller needs: the final answer and a compact trace of
// tool calls, errors and tabs, enough to judge the run and find where it went wrong.
interface Block {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
}
interface Entry {
  timestamp: string;
  message: {
    role: string;
    content: Block[];
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
  } | null;
}
interface Snapshot {
  chat: { chatId: string; title: string };
  runState: string;
  contextUsage: { tokens: number | null } | null;
  entries: Entry[];
}

export interface TraceStep {
  at: string;
  tool: string;
  summary: string;
  error: boolean;
}
export interface ChatResult {
  chatId: string;
  prompt: string;
  status: "finished" | "failed" | "timeout";
  seconds: number;
  answer: string;
  toolCalls: number;
  toolErrors: number;
  tabsOpened: number;
  contextTokens: number | null;
  trace: TraceStep[];
}

export function summarize(
  chatId: string,
  prompt: string,
  raw: unknown,
  elapsedMs: number,
  outcome: "finished" | "timeout",
): ChatResult {
  const snapshot = raw as Snapshot;
  const trace = traceOf(snapshot.entries);
  const error = endingError(snapshot.entries);
  return {
    chatId,
    prompt,
    status: outcome === "timeout" ? "timeout" : error === undefined ? "finished" : "failed",
    seconds: elapsedMs / 1000,
    answer: error ?? answerOf(snapshot.entries),
    toolCalls: trace.length,
    toolErrors: trace.filter((step) => step.error).length,
    tabsOpened: trace.reduce((count, step) => count + countOpened(step.summary), 0),
    contextTokens: snapshot.contextUsage?.tokens ?? null,
    trace,
  };
}

function countOpened(summary: string): number {
  return summary.match(/- openTab /g)?.length ?? 0;
}

// The error message when the last assistant turn ended in an error or was aborted.
function endingError(entries: Entry[]): string | undefined {
  const last = [...entries].reverse().find((entry) => entry.message?.role === "assistant");
  const reason = last?.message?.stopReason;
  if (reason !== "error" && reason !== "aborted") return undefined;
  return last?.message?.errorMessage ?? "The chat ended with an error.";
}

function answerOf(entries: Entry[]): string {
  for (const entry of [...entries].reverse()) {
    if (entry.message?.role !== "assistant") continue;
    const text = entry.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

// Pairs each tool call with its result: what was called, and the first lines of what came back.
function traceOf(entries: Entry[]): TraceStep[] {
  const steps: TraceStep[] = [];
  const byCall = new Map<string, TraceStep>();
  for (const entry of entries) {
    if (entry.message?.role === "assistant") addCalls(entry, steps, byCall);
    else if (entry.message?.role === "tool") addResult(entry.message, byCall);
  }
  return steps;
}

function addCalls(entry: Entry, steps: TraceStep[], byCall: Map<string, TraceStep>): void {
  for (const block of entry.message?.content ?? []) {
    if (block.type !== "tool-call") continue;
    const step = {
      at: entry.timestamp,
      tool: block.toolName ?? "tool",
      summary: JSON.stringify(block.arguments ?? {}).slice(0, 300),
      error: false,
    };
    steps.push(step);
    if (block.toolCallId) byCall.set(block.toolCallId, step);
  }
}

function addResult(message: NonNullable<Entry["message"]>, byCall: Map<string, TraceStep>): void {
  const step = message.toolCallId ? byCall.get(message.toolCallId) : undefined;
  if (!step) return;
  const text = message.content.map((block) => block.text ?? "").join("\n");
  step.summary += "\n" + text.slice(0, 600);
  step.error = Boolean(message.isError);
}
