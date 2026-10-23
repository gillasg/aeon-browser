import { randomUUID } from "node:crypto";
import {
  DaemonUiRequestSchema,
  DaemonUiResponseSchema,
  HelloAckSchema,
  HelloSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "@aeon/protocol";
import WebSocket from "ws";

const TEST_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

export async function connectDevUi(url, grant) {
  const socket = new WebSocket(url, { origin: `chrome-extension://${TEST_EXTENSION_ID}` });
  await waitForOpen(socket, url);
  await performHandshake(socket, grant);
  return createClient(socket);
}

function waitForOpen(socket, url) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", (error) => reject(new Error(`Could not open ${url}: ${error.message}`)));
  });
}

async function performHandshake(socket, grant) {
  const hello = HelloSchema.parse({
    kind: "hello",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    role: "ui",
    connectionGrant: grant,
  });
  const acknowledgement = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Dev Chat handshake timed out.")), 5000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      const payload = JSON.parse(data.toString());
      const result = HelloAckSchema.safeParse(payload);
      if (!result.success)
        reject(new Error(`Dev Chat handshake was rejected: ${JSON.stringify(payload)}`));
      else resolve(result.data);
    });
  });
  socket.send(JSON.stringify(hello));
  await acknowledgement;
}

function createClient(socket) {
  const history = [];
  const waiters = [];
  socket.on("message", (data) => {
    const parsed = DaemonUiResponseSchema.safeParse(JSON.parse(data.toString()));
    if (!parsed.success) return;
    const message = parsed.data;
    history.push(message);
    const matchIndex = waiters.findIndex(({ predicate }) => predicate(message));
    if (matchIndex >= 0) waiters.splice(matchIndex, 1)[0].resolve(message);
  });

  return {
    history,
    socket,
    send(request) {
      socket.send(JSON.stringify(DaemonUiRequestSchema.parse(request)));
    },
    waitFor(predicate, timeoutMs = 5000) {
      const queued = history.find(predicate);
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for a daemon Chat response."));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        socket.once("close", resolve);
        socket.close();
      });
    },
  };
}

export function requestId() {
  return randomUUID();
}
