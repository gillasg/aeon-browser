// Turns a finished chat's view into what a caller needs: the final answer and a compact trace of
// tool calls, errors and tabs, enough to judge the run and find where it went wrong.
import { speedReport, type SpeedReport } from "./speed.js";
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
    actions?: TraceAction[];
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost?: { total?: number };
    };
  } | null;
}
interface Snapshot {
  chat: { chatId: string; title: string };
  runState: string;
  contextUsage: { tokens: number | null } | null;
  entries: Entry[];
}

/**
 * A timed browser action inside a step (epoch ms; box and point in viewport CSS pixels).
 * Screen recorders (Aperture) read these through `aeon trace --json`; keep the shape.
 */
export interface TraceAction {
  kind: string;
  tabId?: number;
  visible?: boolean;
  tStart: number;
  tAct?: number;
  tEnd: number;
  box?: { x: number; y: number; width: number; height: number };
  point?: { x: number; y: number };
  dpr?: number;
  url?: string;
  text?: string;
  scroll?: { direction: string; amount: number; before: number; after: number };
  failed?: boolean;
  effect?: string;
  evidence?: string;
}
export interface TraceStep {
  at: string;
  tool: string;
  summary: string;
  error: boolean;
  /** Seconds from the call to its result. */
  seconds?: number;
  actions?: TraceAction[];
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
  /**
   * The prompt cache across the chat's turns: the share of prompt tokens read from the cache,
   * and the turns where it fell (the prompt changed before the cached part, which costs time
   * and money). Every turn after the first should mostly hit the cache.
   */
  cache?: CacheReport;
  /** Where the latest run's time went: model turns, each tool, sleeps cut, speed tips given. */
  speed?: SpeedReport;
  /** Tokens and estimated cost over the chat's model turns (eval harnesses report these). */
  usage?: UsageTotals;
  /** When the latest prompt was submitted and when the chat finished it (ISO; finishedAt only
   * once finished). Screen recorders (Aperture) frame recordings with these; keep them. */
  promptAt: string | null;
  finishedAt: string | null;
  trace: TraceStep[];
}

export interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD as the provider's price list estimates it; subscriptions report list prices too. */
  cost: number;
}

/** Tokens and cost summed over every assistant turn that reported usage. */
export function usageTotals(entries: Entry[]): UsageTotals | undefined {
  const turns = entries.flatMap((entry) => (entry.message?.usage ? [entry.message.usage] : []));
  if (!turns.length) return undefined;
  const sum = (pick: (usage: (typeof turns)[number]) => number) =>
    turns.reduce((total, usage) => total + pick(usage), 0);
  return {
    turns: turns.length,
    input: sum((usage) => usage.input),
    output: sum((usage) => usage.output),
    cacheRead: sum((usage) => usage.cacheRead),
    cacheWrite: sum((usage) => usage.cacheWrite),
    cost: Math.round(sum((usage) => usage.cost?.total ?? 0) * 1e6) / 1e6,
  };
}

export interface CacheReport {
  turns: number;
  hitRate: number;
  /** Turns (1-based) after the first whose cached share fell below half. */
  misses: number[];
}

/** How well the prompt cache held across the chat's assistant turns. */
export function cacheReport(entries: Entry[]): CacheReport | undefined {
  const turns = entries
    .map((entry) => entry.message?.usage)
    .filter((usage): usage is NonNullable<typeof usage> => Boolean(usage));
  if (!turns.length) return undefined;
  const prompt = (usage: (typeof turns)[number]) =>
    usage.input + usage.cacheRead + usage.cacheWrite;
  const read = turns.reduce((sum, usage) => sum + usage.cacheRead, 0);
  const total = turns.reduce((sum, usage) => sum + prompt(usage), 0);
  const misses = turns
    .map((usage, index) => ({ index, share: prompt(usage) ? usage.cacheRead / prompt(usage) : 1 }))
    .filter(({ index, share }) => index > 0 && share < 0.5)
    .map(({ index }) => index + 1);
  return {
    turns: turns.length,
    hitRate: total ? Math.round((read / total) * 100) / 100 : 0,
    misses,
  };
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
    ...cacheOf(snapshot.entries),
    ...speedOf(snapshot.entries),
    ...usageOf(snapshot.entries),
    promptAt: lastOf(snapshot.entries, "user")?.timestamp ?? null,
    finishedAt:
      outcome === "timeout" || snapshot.runState !== "idle"
        ? null
        : (lastOf(snapshot.entries, "assistant")?.timestamp ?? null),
    trace,
  };
}

function cacheOf(entries: Entry[]): { cache?: CacheReport } {
  const cache = cacheReport(entries);
  return cache ? { cache } : {};
}

function speedOf(entries: Entry[]): { speed?: SpeedReport } {
  const speed = speedReport(entries);
  return speed ? { speed } : {};
}

function usageOf(entries: Entry[]): { usage?: UsageTotals } {
  const usage = usageTotals(entries);
  return usage ? { usage } : {};
}

function lastOf(entries: Entry[], role: string): Entry | undefined {
  return [...entries].reverse().find((entry) => entry.message?.role === role);
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
    else if (entry.message?.role === "tool") addResult(entry, byCall);
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

function addResult(entry: Entry, byCall: Map<string, TraceStep>): void {
  const message = entry.message;
  if (!message) return;
  const step = message.toolCallId ? byCall.get(message.toolCallId) : undefined;
  if (!step) return;
  const text = message.content.map((block) => block.text ?? "").join("\n");
  step.summary += "\n" + text.slice(0, 600);
  step.error = Boolean(message.isError);
  const ms = Date.parse(entry.timestamp) - Date.parse(step.at);
  if (Number.isFinite(ms) && ms >= 0) step.seconds = Math.round(ms / 100) / 10;
  if (message.actions?.length) step.actions = message.actions;
}
