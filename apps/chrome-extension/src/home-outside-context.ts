import type { DaemonUiResponse } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";

// "Let outside agents see my open tabs" is an opt-in setting owned by the daemon. The home page
// reads and changes it; nothing else in the extension needs the value.

export class HomeOutsideContext {
  enabled = false;
  private loaded = false;

  constructor(
    private readonly options: {
      client(): UiClient | undefined;
      onChange(): void;
      onError(message: string): void;
    },
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.send();
  }

  async set(enabled: boolean): Promise<void> {
    await this.send(enabled);
  }

  private async send(enabled?: boolean): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: "settings.outside-context",
        payload: enabled === undefined ? {} : { enabled },
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (
        response.kind !== "command.completed" ||
        response.result.kind !== "settings.outside-context"
      )
        throw new Error("Unexpected outside-context answer.");
      this.enabled = response.result.enabled;
      this.options.onChange();
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }
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
