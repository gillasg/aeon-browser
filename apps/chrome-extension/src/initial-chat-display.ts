import type { ComposerControls, ComposerModel, TranscriptRow } from "@pippin/ui";

interface InitialDisplay { text: string; model: ComposerModel; thinkingLevel: string; }
export function saveInitialDisplay(chatId: string, value: InitialDisplay): void {
  sessionStorage.setItem("aeon-initial-display:" + chatId, JSON.stringify(value));
}
export class InitialChatDisplay {
  private value: InitialDisplay | null = null;
  constructor(private readonly chatId: string) {
    try {
      const raw = sessionStorage.getItem("aeon-initial-display:" + chatId);
      if (raw) this.value = JSON.parse(raw) as InitialDisplay;
    } catch { this.value = null; }
  }
  rows(rows: readonly TranscriptRow[]): readonly TranscriptRow[] {
    if (!this.value) return rows;
    if (rows.some((row) => {
      const message = row.kind === "entry" ? row.entry.message : row.kind === "transient" ? row.message : null;
      return message?.role === "user";
    })) {
      sessionStorage.removeItem("aeon-initial-display:" + this.chatId);
      return rows;
    }
    return [...rows, { kind: "transient", key: "initial-prompt:" + this.chatId,
      message: { role: "user", content: [{ type: "text", text: this.value.text }] } }];
  }
  controls(current: ComposerControls | null): ComposerControls | null {
    if (current?.effectiveModel || !this.value) return current;
    const { model, thinkingLevel } = this.value;
    return { effectiveModel: model, availableModels: [model], thinkingLevel,
      availableThinkingLevels: model.thinkingLevels, steeringQueue: [], followUpQueue: [] };
  }
}
