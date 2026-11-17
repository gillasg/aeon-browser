// Patterns read from an ability, pack or record file are untrusted. A catastrophic pattern such as
// `(a+)+b` on a long run of `a`s can stall the daemon and every chat on it. Every pattern is
// length-checked and run in a vm with a hard timeout, on a capped slice of the input, so one bad
// pattern fails with a clear reason instead of hanging the host.

import { performance } from "node:perf_hooks";
import vm from "node:vm";

export const PATTERN_LIMIT = 500;
export const MATCH_TIMEOUT_MS = 100;
export const INPUT_LIMIT = 64 * 1024;
const FLAG_LIMIT = 8;

export interface RegexBudget {
  remainingMs: number;
}

export function regexBudget(ms = 1000): RegexBudget {
  return { remainingMs: ms };
}

export interface RegexOptions {
  /** RegExp flags, themselves bounded and validated. */
  flags?: string;
  /** Shared budget across several matches in one run. A fresh one is used when omitted. */
  budget?: RegexBudget;
  /** Name used in error messages, e.g. "field match". */
  label?: string;
  /** Override the 64 KB input cap for callers that must scan a larger, already-capped text. */
  inputLimit?: number;
}

/** A captured match: index 0 is the whole match, later entries are capture groups. */
export type BoundedMatch = string[];

const labelOf = (options: RegexOptions) => options.label ?? "regex";

/** Refuses an unusable pattern before it is compiled or shipped to a page. */
export function validatePattern(pattern: string, options: RegexOptions = {}): void {
  const label = labelOf(options);
  if (typeof pattern !== "string" || pattern.length > PATTERN_LIMIT)
    throw new Error(`${label} pattern is over ${PATTERN_LIMIT} characters`);
  const flags = options.flags ?? "";
  if (typeof flags !== "string" || flags.length > FLAG_LIMIT)
    throw new Error(`${label} flags are over ${FLAG_LIMIT} characters`);
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} needs a valid regex (${message})`, { cause: error });
  }
}

interface Runner {
  script: string;
  context: ReturnType<typeof vm.createContext>;
}

function prepare(
  script: string,
  pattern: string,
  options: RegexOptions,
  text: string,
  extra: Record<string, unknown> = {},
): Runner {
  validatePattern(pattern, options);
  return {
    script,
    context: vm.createContext({
      pattern,
      flags: options.flags ?? "",
      text: String(text).slice(0, options.inputLimit ?? INPUT_LIMIT),
      ...extra,
    }),
  };
}

function execute<T>(runner: Runner, options: RegexOptions, budget: RegexBudget): T {
  if (budget.remainingMs <= 0) throw new Error(`${labelOf(options)} ran out of the regex budget`);
  const limit = Math.max(1, Math.min(MATCH_TIMEOUT_MS, Math.floor(budget.remainingMs)));
  const started = performance.now();
  try {
    return new vm.Script(runner.script).runInContext(runner.context, { timeout: limit }) as T;
  } catch (error) {
    if (timedOut(error))
      throw new Error(`${labelOf(options)} pattern took too long; simplify it`, { cause: error });
    throw error;
  } finally {
    budget.remainingMs -= performance.now() - started;
  }
}

/** Bounded regex test. Throws a clear refusal for over-long, invalid or slow patterns. */
export function boundedTest(pattern: string, text: string, options: RegexOptions = {}): boolean {
  const budget = options.budget ?? regexBudget();
  const runner = prepare("new RegExp(pattern, flags).test(text)", pattern, options, text);
  return execute<boolean>(runner, options, budget);
}

/** Bounded regex exec. Returns the whole match and its capture groups, or null. */
export function boundedExec(
  pattern: string,
  text: string,
  options: RegexOptions = {},
): BoundedMatch | null {
  const budget = options.budget ?? regexBudget();
  const runner = prepare(
    "(() => { const m = new RegExp(pattern, flags).exec(text); return m ? Array.from(m) : null; })()",
    pattern,
    options,
    text,
  );
  const match = execute<string[] | null>(runner, options, budget);
  return match ? Array.from(match) : null;
}

/** Bounded global replace, for redaction rules from a pack or overrides file. */
export function boundedReplace(
  pattern: string,
  text: string,
  replacement: string,
  options: RegexOptions = {},
): string {
  const flags = options.flags ?? "";
  if (!/g/.test(flags)) throw new Error(`${labelOf(options)} replace needs the global flag`);
  const budget = options.budget ?? regexBudget();
  const runner = prepare(
    "text.replace(new RegExp(pattern, flags), replacement)",
    pattern,
    options,
    text,
    { replacement },
  );
  return execute<string>(runner, options, budget);
}

function timedOut(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error)
    return error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
  return /timed out/i.test(error instanceof Error ? error.message : String(error));
}
