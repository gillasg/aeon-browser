import { associateComposerContext } from "./composer-context-association.js";
import { editComposerQueue, sendComposerCommand, messageOf } from "./composer-command.js";
import { type DaemonUiResponse } from "@aeon/protocol";
import type { PiBrowserContextRecord } from "@aeon/protocol";
import type { ChatComposerProps, ComposerAttachment, ComposerControls } from "@aeon/ui";
import type { PiAttachmentDto } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";
import { readComposerAttachment } from "./chat-composer-attachments.js";
import { submitComposerMessage } from "./chat-composer-submit.js";

export class ChatComposerController {
  private client: UiClient | undefined;
  private disposed = false;
  private submitting = false;
  private projectName: string | null = null;
  private controls: ComposerControls | null = null;
  private attachments: ComposerAttachment[] = [];
  private editDraftInsertion: { id: number; text: string } | undefined;
  private editNotice: string | null = null;
  private editDraftId = 0;
  private browserContext: PiBrowserContextRecord | null = null;
  private readonly contextAssociations = new Map<string, Promise<void>>();

  constructor(
    private readonly chatId: string,
    private readonly isRunning: () => boolean,
    private readonly onChange: () => void,
    private readonly onError: (message: string) => void,
    private readonly onBrowserContextConsumed: (contextId: string) => void,
    private readonly onBrowserContextStatus: (
      contextId: string,
      status: "current" | "stale" | "lost" | "offline",
    ) => Promise<void>,
  ) {}

  setProjectName(name: string | null): void {
    this.projectName = name;
  }

  setClient(client: UiClient): void {
    this.client = client;
    this.controls = null;
    client.socket.addEventListener(
      "close",
      () => {
        if (this.client === client) {
          this.client = undefined;
          this.onChange();
        }
      },
      { once: true },
    );
    client.subscribe((message) => this.onDaemonMessage(message));
    if (this.browserContext) {
      this.contextAssociations.delete(this.browserContext.contextId);
      void this.ensureBrowserContextAttached(this.browserContext);
    }
    void this.refreshControls();
    this.onChange();
  }

  props(): ChatComposerProps {
    return {
      chatId: this.chatId,
      projectName: this.projectName,
      connected: this.client?.socket.readyState === WebSocket.OPEN,
      running: this.isRunning() || this.submitting,
      starting: this.submitting,
      controls: this.controls,
      attachments: this.attachments,
      ...(this.editDraftInsertion ? { editDraftInsertion: this.editDraftInsertion } : {}),
      editNotice: this.editNotice,
      browserContext: this.browserContext,
      onSend: (text, mode) => this.sendMessage(text, mode),
      onQueueAction: (mode, index, action, text) =>
        editComposerQueue(
          this.controls,
          this.chatId,
          mode,
          index,
          action,
          text,
          (request) => this.command(request),
          this.onError,
          () => this.refreshControls(),
        ),
      onReadDraftAttachments: (files) => Promise.all(files.map(readComposerAttachment)),
      onStart: async (text, model, thinking, files) => {
        this.submitting = true;
        this.onChange();
        try {
          await this.command({
            operation: "chat.model",
            payload: { chatId: this.chatId, provider: model.provider, id: model.id },
          });
          await this.command({
            operation: "chat.thinking",
            payload: { chatId: this.chatId, level: thinking },
          });
          this.attachments = [...files];
          return this.sendMessage(text, "followUp");
        } catch (error) {
          this.onError(messageOf(error));
          return false;
        } finally {
          this.submitting = false;
          this.onChange();
        }
      },
      onStop: () => void this.stop(),
      onModel: (value) => void this.changeModel(value),
      onThinking: (value) => void this.changeThinking(value),
      onAttach: (targetChatId, files) => void this.addAttachments(targetChatId, files),
      onRemoveAttachment: (index) => this.removeAttachment(index),
      onRemoveBrowserContext: () => this.removeBrowserContext(),
    };
  }

  close(): void {
    this.disposed = true;
    this.client = undefined;
  }

  setBrowserContext(record: PiBrowserContextRecord | null): void {
    this.browserContext = record;
    if (record) void this.ensureBrowserContextAttached(record);
    this.onChange();
  }

  sendPrompt(text: string): Promise<boolean> {
    return this.sendMessage(text, "followUp");
  }

  loadEditDraft(
    text: string,
    attachments: readonly PiAttachmentDto[],
    notice: "text_attachments_remain_inline" | null,
  ): void {
    this.attachments = [...attachments];
    this.editDraftInsertion = { id: ++this.editDraftId, text };
    this.editNotice =
      notice === "text_attachments_remain_inline"
        ? "Text attachments from this message remain inline in the draft."
        : null;
    this.onChange();
  }

  private onDaemonMessage(message: DaemonUiResponse): void {
    if (
      message.kind === "chat.event" &&
      message.chatId === this.chatId &&
      message.event.event.kind === "queue-changed"
    )
      void this.refreshControls();
    if (message.kind === "command.settled" && message.chatId === this.chatId)
      void this.refreshControls();
  }

  private async sendMessage(text: string, mode: "followUp" | "steer"): Promise<boolean> {
    const client = this.client;
    if (!text || !client) return false;
    const requestId = crypto.randomUUID();
    const wasRunning = this.isRunning();
    let browserContext = this.browserContext;
    if (browserContext && wasRunning) {
      this.onError("Wait for Pi to finish before sending the attached page context.");
      return false;
    }
    this.submitting = !wasRunning;
    this.onChange();
    try {
      if (browserContext) await this.ensureBrowserContextAttached(browserContext);
      browserContext = this.browserContext;
      const accepted = await submitComposerMessage({
        client,
        chatId: this.chatId,
        requestId,
        text,
        mode,
        wasRunning,
        attachments: this.attachments,
        browserContext,
        onError: this.onError,
      });
      if (!accepted) return false;
      this.attachments = [];
      this.editNotice = null;
      if (
        browserContext &&
        document.body.dataset.host !== "panel" &&
        this.browserContext?.contextId === browserContext.contextId
      ) {
        this.browserContext = null;
        this.onBrowserContextConsumed(browserContext.contextId);
      }
      this.onChange();
      return true;
    } catch (error) {
      this.onError(messageOf(error));
      return false;
    } finally {
      this.submitting = false;
      this.onChange();
    }
  }

  private async addAttachments(targetChatId: string, files: readonly File[]): Promise<void> {
    if (targetChatId !== this.chatId || !files.length) return;
    if (files.length + this.attachments.length > 3) {
      this.onError("Attach up to three files per message.");
      return;
    }
    try {
      const next = await Promise.all(files.map(readComposerAttachment));
      if (targetChatId !== this.chatId) return;
      if (
        [...this.attachments, ...next].reduce((sum, item) => sum + item.byteLength, 0) > 2_097_152
      )
        throw new Error("Combined attachment size exceeds 2 MiB.");
      this.attachments = [...this.attachments, ...next];
      this.onChange();
    } catch (error) {
      this.onError(messageOf(error));
    }
  }

  private removeAttachment(index: number): void {
    this.attachments = this.attachments.filter((_, position) => position !== index);
    this.onChange();
  }

  private removeBrowserContext(): void {
    const contextId = this.browserContext?.contextId;
    this.browserContext = null;
    if (contextId) this.onBrowserContextConsumed(contextId);
    this.onChange();
  }

  private async stop(): Promise<void> {
    try {
      await this.command({ operation: "chat.stop", payload: { chatId: this.chatId } });
    } catch (error) {
      this.onError(`Could not stop Pi · ${messageOf(error)}`);
    }
  }

  async refreshControls(): Promise<void> {
    if (!this.client || this.disposed) return;
    try {
      const response = await this.command({
        operation: "chat.controls",
        payload: { chatId: this.chatId },
      });
      if (response.kind !== "command.completed" || response.result.kind !== "chat.controls") return;
      this.controls = response.result.controls;
      this.onChange();
    } catch (error) {
      this.onError(`Pi settings unavailable · ${messageOf(error)}`);
    }
  }

  private async changeModel(model: ComposerControls["availableModels"][number]): Promise<void> {
    await this.changeControl(
      {
        operation: "chat.model",
        payload: { chatId: this.chatId, provider: model.provider, id: model.id },
      },
      "Pi could not change model",
    );
  }

  private async changeThinking(level: string): Promise<void> {
    if (!level) return;
    await this.changeControl(
      { operation: "chat.thinking", payload: { chatId: this.chatId, level } },
      "Pi could not change thinking level",
    );
  }

  private async changeControl(request: Record<string, unknown>, prefix: string): Promise<void> {
    try {
      await this.command(request);
      await this.refreshControls();
    } catch (error) {
      this.onError(`${prefix} · ${messageOf(error)}`);
      await this.refreshControls();
    }
  }

  private command(request: Record<string, unknown>): Promise<DaemonUiResponse> {
    return sendComposerCommand(this.client, request);
  }

  private ensureBrowserContextAttached(record: PiBrowserContextRecord): Promise<void> {
    if (!this.client) return Promise.resolve();
    return associateComposerContext(
      record,
      this.chatId,
      this.contextAssociations,
      (request) => this.command(request),
      this.onError,
      async (status) => {
        if (this.browserContext?.contextId === record.contextId) {
          this.browserContext = { ...this.browserContext, sourceStatus: status };
          this.onChange();
        }
        await this.onBrowserContextStatus(record.contextId, status);
      },
    );
  }
}
