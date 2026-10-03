import {
  BrowserExecutorHeartbeatReplySchema,
  BrowserExecutorHeartbeatSchema,
} from "@pippin/protocol";
import type { BrowserIdentity } from "./native-worker-identity.js";
export function startExecutorHeartbeat(socket: WebSocket, identity: BrowserIdentity): number {
  let acknowledged = Date.now();
  const onMessage = (event: MessageEvent) => {
    try {
      const reply = BrowserExecutorHeartbeatReplySchema.safeParse(JSON.parse(String(event.data)));
      if (
        reply.success &&
        reply.data.clientInstanceId === identity.clientInstanceId &&
        reply.data.browserRunId === identity.browserRunId
      )
        acknowledged = Date.now();
    } catch {
      /* Other protocol messages are handled by the worker. */
    }
  };
  socket.addEventListener("message", onMessage);
  const timer = globalThis.setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - acknowledged > 65000) {
      socket.close(4004, "Daemon heartbeat expired; reconnect required");
      return;
    }
    try {
      socket.send(
        JSON.stringify(
          BrowserExecutorHeartbeatSchema.parse({ kind: "browser.executor.heartbeat", ...identity }),
        ),
      );
    } catch {
      socket.close(4004, "Executor heartbeat failed");
    }
  }, 20000);
  socket.addEventListener(
    "close",
    () => {
      clearInterval(timer);
      socket.removeEventListener("message", onMessage);
    },
    { once: true },
  );
  return timer;
}
