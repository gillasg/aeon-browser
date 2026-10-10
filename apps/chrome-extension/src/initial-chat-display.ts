import type { ChatComposerProps, ComposerModel, TranscriptRow } from "@aeon/ui";

interface InitialDisplay {
  text: string;
  model: ComposerModel;
  thinkingLevel: string;
}
export function saveInitialDisplay(chatId: string, value: InitialDisplay): void {
  const pages = sessionStorage.getItem("aeon-context-pages:draft");
  if (pages) {
    sessionStorage.setItem("aeon-context-pages:" + chatId, pages);
    sessionStorage.removeItem("aeon-context-pages:draft");
  }
  sessionStorage.setItem("aeon-initial-display:" + chatId, JSON.stringify(value));
}
export class InitialChatDisplay {
  private value: InitialDisplay | null = null;
  constructor(private readonly chatId: string) {
    try {
      const raw = sessionStorage.getItem("aeon-initial-display:" + chatId);
      if (raw) this.value = JSON.parse(raw) as InitialDisplay;
    } catch {
      this.value = null;
    }
  }
  rows(rows: readonly TranscriptRow[]): readonly TranscriptRow[] {
    if (!this.value) return rows;
    if (
      rows.some((row) => {
        const message =
          row.kind === "entry" ? row.entry.message : row.kind === "transient" ? row.message : null;
        return message?.role === "user";
      })
    ) {
      sessionStorage.removeItem("aeon-initial-display:" + this.chatId);
      return rows;
    }
    return [
      ...rows,
      {
        kind: "transient",
        key: "initial-prompt:" + this.chatId,
        message: { role: "user", content: [{ type: "text", text: this.value.text }] },
      },
    ];
  }
  pending(rows: readonly TranscriptRow[]): boolean {
    return (
      Boolean(this.value) &&
      !rows.some((row) => {
        const message =
          row.kind === "entry" ? row.entry.message : row.kind === "transient" ? row.message : null;
        return message?.role === "user";
      })
    );
  }
  composer(
    props: ChatComposerProps,
    rows: readonly TranscriptRow[],
    connection: "connecting" | "connected" | "error",
    runState: "idle" | "running-unconfirmed" | "uncertain" | "needs_attention",
  ): ChatComposerProps {
    return {
      ...props,
      connected: connection === "connected" && props.connected,
      controls: connection === "connected" ? props.controls : null,
      connecting: connection !== "connected",
      preparing:
        connection === "connected" &&
        runState === "idle" &&
        (this.pending(rows) || Boolean(props.starting)),
    };
  }
}
