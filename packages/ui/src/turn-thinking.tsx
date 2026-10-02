import type { ReactElement } from "react";
import type { TranscriptRow } from "./transcript-model.js";
import { ThinkingDisclosure } from "./thinking-disclosure.js";

export function TurnThinking({ rows }: { rows: readonly TranscriptRow[] }): ReactElement | null {
  const blocks = rows.flatMap((row) => {
    const message =
      row.kind === "tool-group"
        ? undefined
        : row.kind === "transient"
          ? row.message
          : row.entry.message;
    return message?.role === "assistant"
      ? message.content.filter((block) => block.type === "thinking" && block.text.trim())
      : [];
  });
  const text = blocks
    .flatMap((block) => (block.type === "thinking" ? [block.text] : []))
    .join("\n\n");
  if (!text) return null;
  return (
    <ThinkingDisclosure
      text={text}
      streaming={rows.some((row) => row.kind === "transient" && row.message.role === "assistant")}
    />
  );
}
