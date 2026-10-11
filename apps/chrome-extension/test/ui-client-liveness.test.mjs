import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test, { mock } from "node:test";

async function loadClient() {
  const directory = await mkdtemp(join(tmpdir(), "aeon-ui-liveness-"));
  const outfile = join(directory, "client.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/ui-client-core.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  return { ...(await import(pathToFileURL(outfile).href)), directory };
}

function fakeSocket() {
  const handlers = new Map();
  const socket = {
    readyState: WebSocket.OPEN,
    sent: [],
    closedWith: undefined,
    addEventListener: (kind, handler) => handlers.set(kind, handler),
    send: (data) => socket.sent.push(JSON.parse(data)),
    close: (code) => {
      socket.closedWith = code;
      socket.readyState = WebSocket.CLOSED;
      handlers.get("close")?.();
    },
    receive: (message) => handlers.get("message")({ data: JSON.stringify(message) }),
  };
  return socket;
}

const done = {
  kind: "command.completed",
  requestId: "00000000-0000-4000-8000-000000000001",
  operation: "chat.resources",
  result: { kind: "chat.stopped", chatId: "00000000-0000-4000-8000-000000000002" },
};

test("slow work keeps waiting while the daemon answers pings", async () => {
  const { UiClient, directory } = await loadClient();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const socket = fakeSocket();
    const client = new UiClient(socket);
    const result = client.waitFor((message) => message.requestId === done.requestId);
    for (let second = 0; second < 45; second += 10) {
      mock.timers.tick(10_000);
      const ping = socket.sent.at(-1);
      assert.equal(ping.kind, "ping");
      socket.receive({ kind: "pong", requestId: ping.requestId });
    }
    socket.receive(done);
    assert.deepEqual(await result, done);
    assert.equal(socket.closedWith, undefined);
  } finally {
    mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a daemon that stops answering is detected and the request fails", async () => {
  const { UiClient, directory } = await loadClient();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const socket = fakeSocket();
    const client = new UiClient(socket);
    const result = client.waitFor((message) => message.requestId === done.requestId);
    mock.timers.tick(10_000);
    assert.equal(socket.sent.at(-1).kind, "ping");
    mock.timers.tick(10_000);
    assert.equal(socket.closedWith, 4008);
    await assert.rejects(result, /connection closed/);
  } finally {
    mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
});
