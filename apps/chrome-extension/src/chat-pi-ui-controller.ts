import {
  DaemonUiRequestSchema,
  type ChatViewSnapshotDto,
  type DaemonUiResponse,
  type PiAttachmentDto,
  type PiSessionEventDto,
  type PiUiSnapshotDto,
} from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";
import type { ChatSurfaceProps, ChatComposerProps } from "@aeon/ui";
type CompletedCommandResult = Extract<DaemonUiResponse, { kind: "command.completed" }>["result"];
type MessageEditResultDto = Extract<CompletedCommandResult, { kind: "chat.message-edited" }>;
type MessageForkResultDto = Extract<CompletedCommandResult, { kind: "chat.message-forked" }>;
type PiUiViewProps = Pick<
  ChatSurfaceProps,
  | "piUi"
  | "piUiOpen"
  | "piUiBusy"
  | "onTogglePiUi"
  | "onRefreshPiUi"
  | "onNavigateTree"
  | "onEditMessage"
  | "onBranchMessage"
  | "onInsertCommand"
  | "onCompact"
  | "onAnswerExtensionUi"
>;
export class ChatPiUiController {
  snapshot: PiUiSnapshotDto | null = null;
  open = false;
  busy = false;
  commandInsertion: { id: number; text: string } | undefined;
  private client: UiClient | undefined;
  private insertionId = 0;
  constructor(
    private readonly chatId: string,
    private readonly onChange: () => void,
    private readonly onView: (
      snapshot: ChatViewSnapshotDto,
      cursor: { epoch: string; revision: number },
    ) => void,
    private readonly onEditDraft: (
      text: string,
      attachments: readonly PiAttachmentDto[],
      notice: "text_attachments_remain_inline" | null,
    ) => void,
    private readonly onOpenForkedChat: (chatId: string) => Promise<void>,
    private readonly onError: (message: string) => void,
  ) {}

  viewProps(): PiUiViewProps {
    return {
      piUi: this.snapshot,
      piUiOpen: this.open,
      piUiBusy: this.busy,
      onTogglePiUi: () => this.toggle(),
      onRefreshPiUi: () => void this.refresh(),
      onNavigateTree: (entryId: string) => this.navigate(entryId),
      onEditMessage: (entryId: string) => this.editMessage(entryId),
      onBranchMessage: (entryId: string) => this.branchMessage(entryId),
      onInsertCommand: (invocation: string) => this.insertCommand(invocation),
      onCompact: () => void this.compact(),
      onAnswerExtensionUi: (requestId: string, value: string | boolean | null) =>
        void this.answerDialog(requestId, value),
    };
  }

  composerProps(): Partial<ChatComposerProps> {
    return this.commandInsertion ? { commandInsertion: this.commandInsertion } : {};
  }

  setClient(client: UiClient | undefined): void {
    this.client = client;
    if (client) void this.refresh();
  }

  toggle(): void {
    this.open = !this.open;
    this.onChange();
    if (this.open) void this.refresh();
  }

  async refresh(): Promise<void> {
    const response = await this.request("chat.pi-ui", { chatId: this.chatId });
    if (response?.kind === "command.completed" && response.result.kind === "chat.pi-ui") {
      this.snapshot = response.result.piUi;
      this.onChange();
    }
  }

  async navigate(entryId: string): Promise<void> {
    const response = await this.request("chat.navigate-tree", { chatId: this.chatId, entryId });
    if (response?.kind === "command.completed" && response.result.kind === "chat.tree-navigated") {
      if (response.result.entryId !== entryId) {
        this.onError("Pi navigated to a different transcript entry than the one selected.");
        return;
      }
      this.onView(response.result.snapshot, response.result.cursor);
      if (!response.result.cancelled && response.result.editorText !== null)
        this.onEditDraft(response.result.editorText, [], null);
    }
    await this.refresh();
  }

  async editMessage(entryId: string): Promise<void> {
    const response = await this.request("chat.edit-message", { chatId: this.chatId, entryId });
    if (response?.kind !== "command.completed" || response.result.kind !== "chat.message-edited")
      return;
    if (response.result.entryId !== entryId) {
      this.onError("Pi returned an edit result for a different transcript entry.");
      return;
    }
    this.onView(response.result.snapshot, response.result.cursor);
    if (response.result.status === "ready") {
      if (response.result.editorText === null) {
        this.onError("Pi navigated to the message but did not return draft text.");
      } else {
        this.onEditDraft(
          response.result.editorText,
          response.result.attachments,
          response.result.notice,
        );
      }
    } else if (response.result.status === "unsupported") {
      this.onError(
        response.result.reason
          ? editUnsupportedMessage(response.result.reason)
          : "Pi cannot restore this message in the composer.",
      );
    }
    await this.refresh();
  }

  async branchMessage(entryId: string): Promise<void> {
    const response = await this.request("chat.fork-message", {
      chatId: this.chatId,
      entryId,
    });
    if (response?.kind !== "command.completed" || response.result.kind !== "chat.message-forked")
      return;
    if (response.result.sourceChatId !== this.chatId || response.result.entryId !== entryId) {
      this.onError("Pi returned a branch result for a different transcript entry.");
      return;
    }
    if (response.result.status === "ready") {
      if (
        !response.result.targetChatId ||
        !response.result.chat ||
        response.result.chat.chatId !== response.result.targetChatId
      ) {
        this.onError("Pi reported a ready branch without a matching new Chat.");
        return;
      }
      try {
        await this.onOpenForkedChat(response.result.targetChatId);
      } catch (error) {
        this.onError(
          `Pi created the branch, but the new chat could not be opened · ${errorMessage(error)}`,
        );
      }
      return;
    }
    this.onError(forkFailureMessage(response.result.reason));
  }

  async compact(): Promise<void> {
    const response = await this.request("chat.compact", { chatId: this.chatId });
    this.applyView(response);
    await this.refresh();
  }

  async answerDialog(dialogRequestId: string, value: string | boolean | null): Promise<void> {
    const response = await this.request("chat.extension-ui-answer", {
      chatId: this.chatId,
      dialogRequestId,
      value,
    });
    if (
      response?.kind === "command.completed" &&
      response.result.kind === "chat.extension-ui-answered" &&
      response.result.accepted
    ) {
      this.applyEvent({ kind: "extension-ui-resolved", requestId: dialogRequestId });
    }
  }

  applyEvent(event: PiSessionEventDto): void {
    const current = this.snapshot ?? {
      tree: [],
      slashCommands: [],
      extensionDialogs: [],
      notices: [],
    };
    if (event.kind === "extension-ui-request") {
      this.snapshot = {
        ...current,
        extensionDialogs: [
          ...current.extensionDialogs.filter(
            (dialog) => dialog.requestId !== event.request.requestId,
          ),
          event.request,
        ].slice(-8),
      };
    } else if (event.kind === "extension-ui-resolved") {
      this.snapshot = {
        ...current,
        extensionDialogs: current.extensionDialogs.filter(
          (dialog) => dialog.requestId !== event.requestId,
        ),
      };
    } else if (event.kind === "extension-ui-notice") {
      this.snapshot = {
        ...current,
        notices: [
          ...current.notices.filter((notice) => notice.noticeId !== event.notice.noticeId),
          event.notice,
        ].slice(-10),
      };
    } else {
      return;
    }
    this.onChange();
  }

  insertCommand(invocation: string): void {
    this.commandInsertion = { id: ++this.insertionId, text: `${invocation} ` };
    this.onChange();
  }

  close(): void {
    this.client = undefined;
  }

  private applyView(response: DaemonUiResponse | undefined): void {
    if (response?.kind !== "command.completed" || response.result.kind !== "chat.view") return;
    this.onView(response.result.snapshot, response.result.cursor);
  }

  private async request(
    operation:
      | "chat.pi-ui"
      | "chat.navigate-tree"
      | "chat.edit-message"
      | "chat.fork-message"
      | "chat.compact"
      | "chat.extension-ui-answer",
    payload: Record<string, unknown>,
  ): Promise<DaemonUiResponse | undefined> {
    const client = this.client;
    if (!client) return undefined;
    const requestId = crypto.randomUUID();
    this.busy = true;
    this.onChange();
    try {
      const after = client.send(
        DaemonUiRequestSchema.parse({ kind: "command", requestId, operation, payload }),
      );
      // These run against the live Pi session: it may be starting, and compaction is a model call.
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
        operation === "chat.compact" ? 600_000 : 60_000,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      return response;
    } catch (error) {
      this.onError(error instanceof Error ? error.message : "Pi session action failed.");
      return undefined;
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
}

function editUnsupportedMessage(reason: NonNullable<MessageEditResultDto["reason"]>): string {
  switch (reason) {
    case "not_user_message":
      return "Only Pi user messages can be edited.";
    case "text_exceeds_composer_limit":
      return "This message is too long to restore in the composer.";
    case "image_attachment_not_supported":
      return "Pi could not restore an image attachment from this message.";
    case "image_attachment_limit_exceeded":
      return "This message has more image data than the composer can restore.";
  }
  return "Pi cannot restore this message in the composer.";
}

function forkFailureMessage(reason: MessageForkResultDto["reason"]): string {
  switch (reason) {
    case "chat_not_ready":
      return "This chat is not ready to branch yet.";
    case "entry_not_found":
      return "This Pi entry is no longer available to branch from.";
    case "branch_without_assistant":
      return "Pi cannot branch from this entry because the branch has no assistant response.";
    case "outcome_uncertain":
      return "Pi could not confirm whether the branch was created. Check your chats before retrying.";
    case "fork_failed":
    case null:
      return "Pi could not create a branch from this response.";
  }
  return "Pi could not create a branch from this response.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The local daemon could not open the new Chat.";
}

function isCommandResponse(
  message: DaemonUiResponse,
  requestId: string,
): message is Extract<DaemonUiResponse, { kind: "command.completed" | "command.failed" }> {
  return (
    (message.kind === "command.completed" || message.kind === "command.failed") &&
    message.requestId === requestId
  );
}
