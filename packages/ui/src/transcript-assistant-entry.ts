import type { PiEntryDto, PiMessageDto } from "@pippin/protocol";
import type { TranscriptRow } from "./transcript-model.js";
export function separatesToolBatch(message: PiMessageDto): boolean {
  return message.content.some(
    (block) => (block.type === "thinking" || block.type === "text") && Boolean(block.text.trim()),
  );
}
export function insertAssistantEntry(rows: TranscriptRow[], entry: PiEntryDto): void {
  const calls = entry.message?.content.filter((block) => block.type === "tool-call") ?? [];
  const index = rows.findIndex(
    (row) =>
      row.kind === "tool-group" &&
      row.group.steps.some((step) => calls.some((call) => call.toolCallId === step.toolCallId)),
  );
  rows.splice(index < 0 ? rows.length : index, 0, {
    kind: "entry",
    key: "entry:" + entry.entryId,
    entry,
  });
}
