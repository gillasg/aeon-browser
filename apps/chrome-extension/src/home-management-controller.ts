import { DaemonUiRequestSchema, type ManagementSnapshotDto } from "@graft/protocol";
import type { ManagementActionName, NewTabHomeProps } from "@graft/ui";
import type { UiClient } from "./ui-client-core.js";

type Theme = "dark" | "midnight" | "light" | "system";
type HomeManagementProps = Pick<
  NewTabHomeProps,
  | "managementSnapshot"
  | "managementLoading"
  | "managementError"
  | "managementSelectedChatId"
  | "theme"
  | "onManagementLoad"
  | "onManagementRefresh"
  | "onManagementSelectChat"
  | "onManagementOpenChat"
  | "onManagementAction"
  | "onTheme"
>;

export class HomeManagementController {
  snapshot: ManagementSnapshotDto | null = null;
  loading = false;
  error = "";
  selectedChatId = "";
  theme: Theme = "dark";
  private requestGeneration = 0;

  constructor(
    private readonly client: () => UiClient | undefined,
    private readonly onChange: () => void,
    private readonly onOpenChat: (chatId: string) => void,
    private readonly managementClient?: () => Promise<UiClient | undefined>,
  ) {}

  viewProps(): HomeManagementProps {
    return {
      managementSnapshot: this.snapshot,
      managementLoading: this.loading,
      managementError: this.error,
      managementSelectedChatId: this.selectedChatId,
      theme: this.theme,
      onManagementLoad: () => void this.load(),
      onManagementRefresh: () => void this.load(),
      onManagementSelectChat: (chatId: string) => {
        this.selectedChatId = chatId;
        void this.load(chatId);
      },
      onManagementOpenChat: this.onOpenChat,
      onManagementAction: (
        chatId: string,
        action: ManagementActionName,
        input: Record<string, unknown>,
      ) => void this.runAction(chatId, action, input),
      onTheme: (value: Theme) => void this.saveTheme(value),
    };
  }

  async readPreferences(): Promise<void> {
    const values = await chrome.storage.sync.get(["graft-theme"]);
    const savedTheme = values["graft-theme"];
    if (savedTheme === "light" || savedTheme === "system" || savedTheme === "midnight")
      this.theme = savedTheme;
    if (savedTheme === "atmosphere") this.theme = "light";
    document.documentElement.dataset.theme = this.theme;
  }

  async load(selectedChatId = this.selectedChatId): Promise<void> {
    await this.loadSnapshot(selectedChatId, true);
  }

  private async getManagementClient(): Promise<UiClient | undefined> {
    return this.managementClient ? this.managementClient() : this.client();
  }

  private async loadSnapshot(selectedChatId: string, chooseDefaultChat: boolean): Promise<void> {
    const generation = ++this.requestGeneration;
    this.loading = true;
    this.error = "";
    this.onChange();
    let loadDefaultChatResources = false;
    try {
      const activeClient = await this.getManagementClient();
      if (!activeClient) return;
      if (generation !== this.requestGeneration) return;
      const requestId = crypto.randomUUID();
      const after = activeClient.send(
        DaemonUiRequestSchema.parse({
          kind: "command",
          requestId,
          operation: "management.get",
          payload: selectedChatId ? { chatId: selectedChatId } : {},
        }),
      );
      const response = await activeClient.waitFor(
        (message) =>
          (message.kind === "command.completed" || message.kind === "command.failed") &&
          message.requestId === requestId,
        after,
      );
      if (generation !== this.requestGeneration) return;
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== "management.snapshot")
        throw new Error("Graft returned an invalid management snapshot.");
      this.snapshot = response.result.snapshot;
      loadDefaultChatResources = this.chooseDefaultChat(chooseDefaultChat);
    } catch (error) {
      if (generation === this.requestGeneration) this.error = toMessage(error);
    } finally {
      this.finishRequest(generation, loadDefaultChatResources);
    }
  }

  private async runAction(
    chatId: string,
    action: ManagementActionName,
    input: Record<string, unknown>,
  ): Promise<void> {
    const generation = ++this.requestGeneration;
    this.selectedChatId = chatId;
    this.loading = true;
    this.error = "";
    this.onChange();
    try {
      const activeClient = await this.getManagementClient();
      if (!activeClient) return;
      const requestId = crypto.randomUUID();
      const after = activeClient.send(
        DaemonUiRequestSchema.parse({
          kind: "command",
          requestId,
          operation: "management.action",
          payload: { chatId, action, input },
        }),
      );
      const response = await activeClient.waitFor(
        (message) =>
          (message.kind === "command.completed" || message.kind === "command.failed") &&
          message.requestId === requestId,
        after,
      );
      if (generation !== this.requestGeneration) return;
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== "management.snapshot")
        throw new Error("Graft returned an invalid management action response.");
      this.snapshot = response.result.snapshot;
    } catch (error) {
      if (generation === this.requestGeneration) this.error = toMessage(error);
    } finally {
      if (generation === this.requestGeneration) {
        this.loading = false;
        this.onChange();
      }
    }
  }

  private chooseDefaultChat(choose: boolean): boolean {
    if (!choose || this.selectedChatId) return false;
    this.selectedChatId = this.snapshot?.chats[0]?.chatId ?? "";
    return Boolean(this.selectedChatId);
  }

  private finishRequest(generation: number, loadDefaultChatResources: boolean): void {
    if (generation !== this.requestGeneration) return;
    this.loading = false;
    this.onChange();
    if (loadDefaultChatResources) void this.load(this.selectedChatId);
  }

  private async saveTheme(value: Theme): Promise<void> {
    this.theme = value;
    document.documentElement.dataset.theme = value;
    await chrome.storage.sync.set({ "graft-theme": value });
    this.onChange();
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The local Chat command could not complete.";
}
