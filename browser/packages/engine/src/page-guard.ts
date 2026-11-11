// A read that already states its own facts.

import { readGuard } from "./read-guards.js";

export function pageGuard(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object") return {};
  const guard = request as Record<string, unknown>;
  if (guard.kind === "read") return readGuard(readInput(guard));
  return {};
}

function readInput(guard: Record<string, unknown>): {
  text: string;
  count: number;
  shown?: number;
  total?: number;
} {
  return {
    text: text(guard.text),
    count: typeof guard.count === "number" ? guard.count : 0,
    ...(typeof guard.shown === "number" ? { shown: guard.shown } : {}),
    ...(typeof guard.total === "number" ? { total: guard.total } : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
