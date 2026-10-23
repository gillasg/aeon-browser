import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type PiTranscriptMatch, type PiSessionReference } from "@aeon/domain";
import { assertOwnedSessionPath } from "./session-resolver.js";

export function searchTranscript(
  sessionDirectory: string,
  reference: PiSessionReference,
  workingDirectory: string,
  query: string,
): PiTranscriptMatch | undefined {
  const sessionFile = assertOwnedSessionPath(sessionDirectory, reference.sessionFile);
  const manager = SessionManager.open(sessionFile, sessionDirectory, workingDirectory);
  if (manager.getSessionId() !== reference.sessionId) {
    throw new Error("Pi search opened a session that does not match the stored reference.");
  }
  const needle = normalize(query).toLocaleLowerCase();
  if (!needle) return undefined;
  const entries = manager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "message" ||
      (entry.message.role !== "user" && entry.message.role !== "assistant")
    )
      continue;
    const text = textFromMessage(entry.message);
    const normalized = normalize(text);
    const matchIndex = normalized.toLocaleLowerCase().indexOf(needle);
    if (matchIndex < 0) continue;
    return {
      entryId: entry.id,
      role: entry.message.role,
      excerpt: excerptAt(normalized, matchIndex, needle.length),
    };
  }
  return undefined;
}

function textFromMessage(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block: unknown) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return [];
      return [block.text];
    })
    .join(" ");
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 56);
  const end = Math.min(text.length, index + length + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`.slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
