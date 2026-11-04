import type { DaemonUiResponse } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";

// On/off settings owned by the daemon ("Let outside agents see my open tabs", "Load my Pi
// extensions"). The home page reads and changes them; nothing else in the extension needs them.

type SwitchOperation = "settings.outside-context" | "settings.pi-extensions";

export class HomeOutsideContext {
  enabled = false;
  private loaded = false;

  constructor(
    private readonly options: {
      client(): UiClient | undefined;
      onChange(): void;
      onError(message: string): void;
      operation?: SwitchOperation;
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

  private get operation(): SwitchOperation {
    return this.options.operation ?? "settings.outside-context";
  }

  private async send(enabled?: boolean): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: this.operation,
        payload: enabled === undefined ? {} : { enabled },
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== this.operation)
        throw new Error("Unexpected settings answer.");
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
