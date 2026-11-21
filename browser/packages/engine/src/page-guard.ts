// A read that already states its own facts.

import { rateLimitError } from "./rate-limit.js";
import { readGuard } from "./read-guards.js";

export function pageGuard(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object") return {};
  const guard = request as Record<string, unknown>;
  if (guard.kind !== "read") return {};
  const input = readInput(guard);
  const limited = rateLimitError(input.text, statusOf(guard.status), input.title);
  return {
    ...readGuard(input),
    ...(limited ? { rateLimited: limited } : {}),
  };
}

function readInput(guard: Record<string, unknown>): {
  text: string;
  count: number;
  title: string;
  shown?: number;
  total?: number;
} {
  return {
    text: text(guard.text),
    title: text(guard.title),
    count: typeof guard.count === "number" ? guard.count : 0,
    ...(typeof guard.shown === "number" ? { shown: guard.shown } : {}),
    ...(typeof guard.total === "number" ? { total: guard.total } : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function statusOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
