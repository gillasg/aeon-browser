import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";

// core.ping on the daemon's WebSocket. The event loop must answer it; a blocked loop still
// accepts TCP. One 2 s budget covers connect, handshake and the reply, like the launcher.

export const DEFAULT_PING_BUDGET_MS = 2000;

export async function corePing(dataDirectory, budgetMs = DEFAULT_PING_BUDGET_MS) {
  try {
    const port = portFrom(join(dataDirectory, "core-connection.json"));
    if (!port) return false;
    return await ping(port, budgetMs);
  } catch {
    return false;
  }
}

function portFrom(path) {
  const match = /ws:\/\/127\.0\.0\.1:(\d+)\/core\/v1/.exec(readFileSync(path, "utf8"));
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function ping(port, budgetMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const deadline = Date.now() + budgetMs;
    let seen = "";
    let handshook = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), budgetMs);
    timer.unref?.();
    const remaining = () => Math.max(0, deadline - Date.now());
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /core/v1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      socket.setTimeout(remaining(), () => finish(false));
    });
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      if (!handshook) {
        if (!seen.includes(" 101 ")) return;
        handshook = true;
        seen = "";
        socket.write(frame(JSON.stringify({ kind: "core.ping", requestId: randomUUID() })));
        socket.setTimeout(remaining(), () => finish(false));
        return;
      }
      if (seen.includes("core.ping.result")) finish(true);
    });
  });
}

/** One masked text frame; our ping payload is always shorter than 126 bytes. */
function frame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > 125) throw new Error("The core ping payload is too long.");
  const mask = randomBytes(4);
  const head = Buffer.from([0x81, 0x80 | payload.length]);
  const body = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++)
    body[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([head, mask, body]);
}
