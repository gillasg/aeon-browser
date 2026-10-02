import { DaemonUiRequestSchema } from "@pippin/protocol";
import { connectPage } from "./ui-connection.js";
import { openNewChat } from "./new-chat-navigation.js";
import type { DevUiClient } from "./dev-ui-client.js";
let connection: Promise<DevUiClient> | undefined;
async function projectClient(): Promise<DevUiClient> {
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
window.addEventListener("pippin.project-request", (event) => {
  const detail = (event as CustomEvent).detail;
  void projectRequest(detail.operation, detail.payload).then(detail.resolve, detail.reject);
});
window.addEventListener("pippin.project-new-chat", (event) =>
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
    operation === "project.pick-folder" ? 150_000 : 60_000,
  );
  if (response.kind === "command.failed") throw new Error(response.message);
  if (response.kind !== "command.completed") throw new Error("Unexpected project response.");
  return response.result;
}
export function projectDraftPayload(): { projectId?: string } {
  const projectId = new URLSearchParams(location.search).get("projectId");
  return projectId ? { projectId } : {};
}
