import {
  DaemonUiRequestSchema,
  type HomeRoutineCardDto,
  type ManagementSnapshotDto,
} from "@pippin/protocol";
import type { ManagementActionName, NewTabHomeProps } from "@pippin/ui";
import type { DevUiClient } from "./dev-ui-client.js";

type Theme = "dark" | "midnight" | "light" | "system";
type HomeManagementProps = Pick<
  NewTabHomeProps,
  | "managementSnapshot"
  | "homeRoutines"
  | "managementLoading"
  | "managementError"
  | "managementSelectedChatId"
  | "theme"
  | "sidebarDefaultOpen"
  | "onManagementLoad"
  | "onManagementRefresh"
  | "onManagementSelectChat"
  | "onManagementOpenChat"
  | "onManagementAction"
  | "onTheme"
  | "onSidebarDefault"
>;

export class HomeManagementController {
  snapshot: ManagementSnapshotDto | null = null;
  homeRoutines: HomeRoutineCardDto[] = [];
  loading = false;
  error = "";
  selectedChatId = "";
  theme: Theme = "dark";
  sidebarDefaultOpen = false;
  private requestGeneration = 0;

  constructor(
    private readonly client: () => DevUiClient | undefined,
    private readonly onChange: () => void,
    private readonly onOpenChat: (chatId: string) => void,
    private readonly managementClient?: () => Promise<DevUiClient | undefined>,
  ) {}

  viewProps(): HomeManagementProps {
    return {
      managementSnapshot: this.snapshot,
      homeRoutines: this.homeRoutines,
      managementLoading: this.loading,
      managementError: this.error,
      managementSelectedChatId: this.selectedChatId,
      theme: this.theme,
      sidebarDefaultOpen: this.sidebarDefaultOpen,
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
      onSidebarDefault: (value: boolean) => void this.saveSidebarDefault(value),
    };
  }

  async readPreferences(): Promise<void> {
    const values = await chrome.storage.sync.get(["pippin-theme", "pippin-chat-sidebar-open"]);
    const savedTheme = values["pippin-theme"];
    if (savedTheme === "light" || savedTheme === "system" || savedTheme === "midnight") this.theme = savedTheme;
    if (savedTheme === "atmosphere") this.theme = "light";
    this.sidebarDefaultOpen = values["pippin-chat-sidebar-open"] === true;
    document.documentElement.dataset.theme = this.theme;
  }

  async load(selectedChatId = this.selectedChatId): Promise<void> {
    await this.loadSnapshot(selectedChatId, true);
  }

  async loadForHome(): Promise<void> {
    const activeClient = this.client();
    if (!activeClient) return;
    this.error = "";
    try {
      const requestId = crypto.randomUUID();
      const after = activeClient.send(
        DaemonUiRequestSchema.parse({
          kind: "command",
          requestId,
          operation: "management.home",
          payload: {},
        }),
      );
      const response = await activeClient.waitFor(
        (message) =>
          (message.kind === "command.completed" || message.kind === "command.failed") &&
          message.requestId === requestId,
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== "management.home")
        throw new Error("Aeon returned an invalid home routine snapshot.");
      this.homeRoutines = response.result.snapshot.routines;
    } catch (error) {
      this.error = toMessage(error);
    }
    this.onChange();
  }

  private async getManagementClient(): Promise<DevUiClient | undefined> {
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
        throw new Error("Aeon returned an invalid management snapshot.");
      this.snapshot = response.result.snapshot;
      this.homeRoutines = response.result.snapshot.routines.slice(0, 3).map((routine) => ({
        routineId: routine.routineId,
        chatId: routine.chatId,
        chatTitle: routine.chatTitle,
        title: routine.title,
        nextDueAt: routine.nextDueAt,
        enabled: routine.enabled,
      }));
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
        throw new Error("Aeon returned an invalid management action response.");
      this.snapshot = response.result.snapshot;
      this.homeRoutines = response.result.snapshot.routines.slice(0, 3).map((routine) => ({
        routineId: routine.routineId,
        chatId: routine.chatId,
        chatTitle: routine.chatTitle,
        title: routine.title,
        nextDueAt: routine.nextDueAt,
        enabled: routine.enabled,
      }));
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
    await chrome.storage.sync.set({ "pippin-theme": value });
    this.onChange();
  }

  private async saveSidebarDefault(value: boolean): Promise<void> {
    this.sidebarDefaultOpen = value;
    await chrome.storage.sync.set({ "pippin-chat-sidebar-open": value });
    this.onChange();
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The local Chat command could not complete.";
}
