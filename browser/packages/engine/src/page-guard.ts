// A click that would send an official form, or a read that already states its own facts.

import { officialSubmitStop } from "./official-form.js";
import { readGuard } from "./read-guards.js";

export function pageGuard(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object") return {};
  const guard = request as Record<string, unknown>;
  if (guard.kind === "read") return readGuard(readInput(guard));
  if (guard.kind === "submit") return submitGuard(guard);
  return {};
}

function submitGuard(guard: Record<string, unknown>): { stop?: string } {
  const stop = officialSubmitStop({
    host: text(guard.host),
    label: text(guard.label),
    task: text(guard.task),
    pageText: text(guard.pageText),
    extraHosts: Array.isArray(guard.extraHosts) ? guard.extraHosts.map(text) : [],
    ...(guard.fieldEnter === true ? { fieldEnter: true } : {}),
  });
  return stop ? { stop } : {};
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
