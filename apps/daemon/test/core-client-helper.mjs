import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { CoreDiscoverySchema, SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";

export async function connectCore(directory, surface = "development") {
  const discovery = CoreDiscoverySchema.parse(
    JSON.parse(await readFile(join(directory, "core-connection.json"), "utf8")),
  );
  const socket = new WebSocket(discovery.endpoint);
  const history = [];
  socket.on("message", (data) => history.push(JSON.parse(String(data))));
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      kind: "core.hello",
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      surface,
      clientId: randomUUID(),
      token: discovery.token,
    }),
  );
  await until(() => history.some((message) => message.kind === "core.ready"));
  return { socket, history };
}
export async function command(client, operation, payload) {
  const requestId = randomUUID();
  client.socket.send(JSON.stringify({ kind: "command", requestId, operation, payload }));
  await until(() =>
    client.history.some(
      (message) =>
        message.requestId === requestId &&
        ["command.completed", "command.failed", "command.started"].includes(message.kind),
    ),
  );
  const response = client.history.find((message) => message.requestId === requestId);
  if (response.kind === "command.failed") throw new Error(response.code + ": " + response.message);
  return response;
}
export async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Core client request timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
