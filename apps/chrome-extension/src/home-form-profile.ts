import type { DaemonUiResponse } from "@aeon/protocol";
import type { FormField } from "@aeon/ui";
import type { UiClient } from "./ui-client-core.js";

// Settings → Forms: the form profile lives in browserkit's data folder, behind the daemon. Home
// reads it when Settings opens and sends each edit; the answer is always the whole profile.

export class HomeFormProfile {
  fields: FormField[] = [];
  refused: string | undefined;
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
    await this.send({ action: "read" });
  }

  save(field: string, value: string): Promise<void> {
    return this.send({ action: "save", field, value });
  }

  remove(field: string): Promise<void> {
    return this.send({ action: "remove", field });
  }

  private async send(payload: {
    action: "read" | "save" | "remove";
    field?: string;
    value?: string;
  }): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: "settings.form-profile",
        payload,
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== "settings.form-profile")
        throw new Error("Unexpected form profile answer.");
      this.fields = response.result.fields;
      this.refused = response.result.refused;
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
