import { DaemonUiRequestSchema } from "@aeon/protocol";
import type { ChatSurfaceProps, LoadedResourcesState } from "@aeon/ui";
import type { UiClient } from "./ui-client-core.js";

export class ChatResourcesController {
  open = false;
  state: LoadedResourcesState = { kind: "idle" };
  private client: UiClient | undefined;
  private generation = 0;

  constructor(
    private readonly chatId: string,
    private readonly onChange: () => void,
  ) {}

  setClient(client: UiClient): void {
    this.client = client;
  }

  toggle(): void {
    this.open = !this.open;
    this.onChange();
    if (this.open) void this.refresh();
  }

  viewProps(): Pick<
    ChatSurfaceProps,
    "resourcesOpen" | "resources" | "onToggleResources" | "onRefreshResources"
  > {
    return {
      resourcesOpen: this.open,
      resources: this.state,
      onToggleResources: () => this.toggle(),
      onRefreshResources: () => void this.refresh(),
    };
  }

  markDisconnected(): void {
    this.generation += 1;
    this.client = undefined;
    this.setState({
      kind: "unavailable",
      message: "The daemon connection closed. Reconnect, then refresh this Chat's Pi resources.",
    });
  }

  async refresh(): Promise<void> {
    const client = this.client;
    if (!client) {
      this.setState({ kind: "unavailable", message: "The daemon connection is unavailable." });
      return;
    }
    const generation = ++this.generation;
    this.setState({ kind: "loading" });
    try {
      const requestId = crypto.randomUUID();
      const after = client.send(
        DaemonUiRequestSchema.parse({
          kind: "command",
          requestId,
          operation: "chat.resources",
          payload: { chatId: this.chatId },
        }),
      );
      const response = await client.waitFor(
        (message) =>
          (message.kind === "command.completed" || message.kind === "command.failed") &&
          message.requestId === requestId,
        after,
      );
      if (generation !== this.generation) return;
      if (response.kind === "command.failed") {
        this.setState({ kind: "unavailable", message: response.message });
      } else if (
        response.kind === "command.completed" &&
        response.operation === "chat.resources" &&
        response.result.kind === "chat.resources"
      ) {
        this.setState({ kind: "loaded", resources: response.result.resources });
      } else {
        this.setState({
          kind: "unavailable",
          message: "The daemon returned an unexpected resource response.",
        });
      }
    } catch (error) {
      if (generation === this.generation)
        this.setState({
          kind: "unavailable",
          message: error instanceof Error ? error.message : "The resource request failed.",
        });
    }
  }

  private setState(state: LoadedResourcesState): void {
    this.state = state;
    this.onChange();
  }
}
