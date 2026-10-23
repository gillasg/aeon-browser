import type { ChatId } from "@aeon/domain";
import type { ManagementActionName } from "./management-actions.js";

export class ChatManagementCommands {
  private reader: ((chatId?: ChatId) => Promise<unknown>) | undefined;
  private homeReader: (() => Promise<unknown>) | undefined;
  private actionRunner:
    | ((
        chatId: ChatId,
        action: ManagementActionName,
        input: Record<string, unknown>,
      ) => Promise<void>)
    | undefined;

  constructor(
    private readonly hasChat: (chatId: ChatId) => boolean,
    private readonly listChats: () => unknown,
  ) {}

  setReader(reader: (chatId?: ChatId) => Promise<unknown>): void {
    this.reader = reader;
  }

  setHomeReader(reader: () => Promise<unknown>): void {
    this.homeReader = reader;
  }

  readHomeSnapshot(): Promise<unknown> {
    return this.homeReader?.() ?? Promise.resolve({ routines: [] });
  }

  readSnapshot(chatId?: ChatId): Promise<unknown> {
    return (
      this.reader?.(chatId) ??
      Promise.resolve({
        chats: this.listChats(),
        routines: [],
        capabilityRevision: 0,
        capabilities: [],
        resources: null,
        resourceError: null,
      })
    );
  }

  setActionRunner(
    runner: (
      chatId: ChatId,
      action: ManagementActionName,
      input: Record<string, unknown>,
    ) => Promise<void>,
  ): void {
    this.actionRunner = runner;
  }

  runAction(
    chatId: ChatId,
    action: ManagementActionName,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hasChat(chatId)) return Promise.reject(new Error("Action Chat does not exist."));
    if (!this.actionRunner)
      return Promise.reject(new Error("Management actions are unavailable in this runtime."));
    return this.actionRunner(chatId, action, input);
  }
}
