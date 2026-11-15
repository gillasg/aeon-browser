import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createSandbox, cleanup } from "./node-helpers.mjs";
import { corePing } from "../node/health.mjs";

test("core.ping uses one 2 s budget when the handshake is late", { timeout: 15_000 }, async () => {
  const sandbox = createSandbox();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    setTimeout(() => {
      if (socket.destroyed) return;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    }, 1500);
    socket.on("data", () => {
      if (socket.destroyed) return;
      const payload = Buffer.from('{"kind":"core.ping.result","ok":true}');
      const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
      socket.write(frame);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  writeConnection(sandbox, port);
  try {
    const started = Date.now();
    const answered = await corePing(sandbox.data, 2000);
    const elapsed = Date.now() - started;
    assert.equal(answered, true);
    assert.ok(elapsed > 1200, `elapsed ${elapsed} ms`);
    assert.ok(elapsed < 2800, `elapsed ${elapsed} ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await cleanup(sandbox);
  }
});

test("core.ping is false when the event loop never answers", { timeout: 10_000 }, async () => {
  const sandbox = createSandbox();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeConnection(sandbox, server.address().port);
  try {
    assert.equal(await corePing(sandbox.data, 300), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await cleanup(sandbox);
  }
});

function writeConnection(sandbox, port) {
  mkdirSync(sandbox.data, { recursive: true });
  writeFileSync(
    join(sandbox.data, "core-connection.json"),
    JSON.stringify({ endpoint: `ws://127.0.0.1:${port}/core/v1`, token: "x", pid: 1 }),
  );
}
