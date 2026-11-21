import { toOffscreen } from "./code-offscreen-host.js";

/** A deadline keeps the realm. The sandbox posts whatever the cell had already built. */
export function interruptCell(chatId: string, cellId: string): void {
  void toOffscreen({
    target: "aeon-code-offscreen",
    kind: "interrupt",
    chatId,
    cellId,
  }).catch(() => undefined);
}

/** What a finished cell posts back to the host. */
export type CellOutcome = {
  value?: unknown;
  output?: string;
  error?: string;
  reset?: boolean;
  screenshots?: string[];
};

/**
 * Helper CDP is not an agent step. The step schema is strict, so this flag leaves the request
 * and the caller keeps it on the log entry instead.
 */
export function takeInternal(value: Record<string, unknown>): boolean {
  const internal = value.internal === true;
  if (internal) delete value.internal;
  return internal;
}

/** Value and screenshot paths the result message may carry. */
export function cellPayload(result: CellOutcome): {
  value?: unknown;
  screenshots?: string[];
} {
  return {
    ...(result.value !== undefined ? { value: result.value } : {}),
    ...(result.screenshots?.length ? { screenshots: result.screenshots.slice(0, 32) } : {}),
  };
}
