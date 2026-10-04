import { createHash } from "node:crypto";
import type { ThreadDeliveryState } from "@pippin/domain";

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Thread tool input must be an object.");
  return value as Record<string, unknown>;
}

export function requiredString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || !raw.trim() || raw.length > maxLength)
    throw new Error(`${key} must contain 1–${maxLength} characters.`);
  return raw.trim();
}

export function integer(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${name} must be between ${min} and ${max}.`);
  return value as number;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function stateRank(state: ThreadDeliveryState): number {
  return {
    pending: 0,
    submitting: 1,
    queued: 2,
    accepted: 3,
    running: 4,
    failed: 5,
    completed: 5,
    uncertain: 6,
  }[state];
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWithKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => next);
  locks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
