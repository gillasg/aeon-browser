import { boundedText } from "./tool-label-values.js";
export function outcomeText(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return summarizePayload(JSON.parse(text));
    } catch {
      return "";
    }
  }
  return boundedText(text);
}

export function shellOutcome(value: string): string {
  const text = value.trim();
  if (!text) return "Completed";
  if (text.startsWith("{") || text.startsWith("[")) return outcomeText(text) || "Completed";
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 1
    ? `Completed · ${lines.length} lines of output`
    : boundedText(lines[0] ?? text);
}

function summarizePayload(value: unknown): string {
  const queue = [value];
  const seen = new Set<unknown>();
  let actionCount = 0;
  while (queue.length && seen.size < 100) {
    const next = queue.shift();
    if (!next || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) queue.push(...next.slice(0, 20));
    else {
      const record = summarizeRecord(next as Record<string, unknown>, queue);
      if (record.text) return record.text;
      actionCount = Math.max(actionCount, record.actionCount);
    }
  }
  return actionCount > 1 ? `Completed ${actionCount} actions` : "Completed";
}

function summarizeRecord(
  item: Record<string, unknown>,
  queue: unknown[],
): { text?: string; actionCount: number } {
  if (typeof item.error === "string") return { text: boundedText(item.error), actionCount: 0 };
  if (Array.isArray(item.tabs)) {
    const count = item.tabs.length;
    return { text: `Found ${count} open tab${count === 1 ? "" : "s"}`, actionCount: 0 };
  }
  if (item.kind === "page" && typeof item.title === "string")
    return { text: `Read ${boundedText(item.title)}`, actionCount: 0 };
  const actionCount = Array.isArray(item.steps) ? item.steps.length : 0;
  if (Array.isArray(item.steps)) queue.push(...item.steps.slice(0, 20));
  appendPayloadChildren(item, queue, ["result", "data", "output"]);
  const text = findPayloadText(item);
  return text ? { text, actionCount } : { actionCount };
}

function appendPayloadChildren(
  item: Record<string, unknown>,
  queue: unknown[],
  keys: readonly string[],
): void {
  for (const key of keys) if (item[key] && typeof item[key] === "object") queue.push(item[key]);
}

function findPayloadText(item: Record<string, unknown>): string | undefined {
  for (const key of ["message", "text", "output"])
    if (typeof item[key] === "string") return boundedText(item[key] as string);
  return undefined;
}
