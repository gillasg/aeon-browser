import { DaemonUiRequestSchema } from "@aeon/protocol";
import { connectPage } from "./ui-connection.js";
import { openNewChat } from "./new-chat-navigation.js";
import type { UiClient } from "./ui-client-core.js";
let connection: Promise<UiClient> | undefined;
async function projectClient(): Promise<UiClient> {
  connection ??= connectPage({ kind: "catalog" }).then((result) => {
    if (result.kind !== "connected") {
      connection = undefined;
      throw new Error("The local daemon is unavailable.");
    }
    result.client.socket.addEventListener(
      "close",
      () => {
        connection = undefined;
      },
      { once: true },
    );
    window.addEventListener("pagehide", () => result.client.close(), { once: true });
    return result.client;
  });
  return connection;
}
window.addEventListener("aeon.project-request", (event) => {
  const detail = (event as CustomEvent).detail;
  void projectRequest(detail.operation, detail.payload).then(detail.resolve, detail.reject);
});
window.addEventListener("aeon.project-new-chat", (event) =>
  openNewChat((event as CustomEvent<string>).detail),
);
async function projectRequest(operation: string, payload: unknown): Promise<unknown> {
  const client = await projectClient();
  const requestId = crypto.randomUUID();
  const after = client.send(
    DaemonUiRequestSchema.parse({ kind: "command", requestId, operation, payload }),
  );
  const response = await client.waitFor(
    (message) =>
      (message.kind === "command.completed" || message.kind === "command.failed") &&
      message.requestId === requestId,
    after,
  );
  if (response.kind === "command.failed") throw new Error(response.message);
  if (response.kind !== "command.completed") throw new Error("Unexpected project response.");
  return response.result;
}
export function projectDraftPayload(): { projectId?: string } {
  const projectId = new URLSearchParams(location.search).get("projectId");
  return projectId ? { projectId } : {};
}

window.addEventListener("aeon.panel-current-page", (event) => {
  const detail = (event as CustomEvent).detail;
  void chrome.runtime
    .sendMessage({ kind: "aeon.native.current-page" })
    .then(detail.resolve, detail.reject);
});

window.addEventListener("aeon.context-picker", (event) => {
  const detail = (event as CustomEvent).detail;
  const message =
    detail.kind === "list"
      ? { kind: "aeon.native.list-context-tabs" }
      : { kind: "aeon.native.capture-page", tabId: detail.tabId };
  void chrome.runtime.sendMessage(message).then(detail.resolve, detail.reject);
});
