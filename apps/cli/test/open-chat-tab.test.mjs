// graft open prints the chat tab's id, so the agent can read or screenshot that tab by id.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { GraftClient } from "../dist/client.js";
import { graftCommands } from "../dist/commands.js";

const CHAT = "968c135b-a48f-4f5e-9223-dff7f9a10a07";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {}
}

async function printedBy(open) {
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (text) => {
    lines.push(String(text));
    return true;
  };
  try {
    const code = await open();
    return { code, lines };
  } finally {
    process.stdout.write = write;
  }
}

test("the client resolves an open with the browser count and the chat tab's id", async () => {
  const socket = new FakeSocket();
  const client = new GraftClient(socket);
  const opened = client.openChat(CHAT, true);
  assert.deepEqual(socket.sent.at(-1), { kind: "core.chat.open", chatId: CHAT, active: true });
  socket.emit(
    "message",
    JSON.stringify({ kind: "core.chat.opened", chatId: CHAT, browsers: 1, tabId: 42 }),
  );
  assert.deepEqual(await opened, { browsers: 1, tabId: 42 });
});

test("graft open prints the tab id; without one it still says the chat opened", async () => {
  const withId = { connect: async () => ({ openChat: async () => ({ browsers: 1, tabId: 42 }) }) };
  const open = graftCommands(withId).find((entry) => entry.name === "open");
  const shown = await printedBy(() => open.run({ positional: [CHAT], flags: {} }));
  assert.equal(shown.code, 0);
  assert.deepEqual(shown.lines, ["Opened tab 42.\n"]);

  const withoutId = { connect: async () => ({ openChat: async () => ({ browsers: 1 }) }) };
  const plain = graftCommands(withoutId).find((entry) => entry.name === "open");
  assert.deepEqual((await printedBy(() => plain.run({ positional: [CHAT], flags: {} }))).lines, [
    "Opened.\n",
  ]);
});

test("graft open with no connected Chrome fails and says so", async () => {
  const none = { connect: async () => ({ openChat: async () => ({ browsers: 0 }) }) };
  const open = graftCommands(none).find((entry) => entry.name === "open");
  const shown = await printedBy(() => open.run({ positional: [CHAT], flags: {} }));
  assert.equal(shown.code, 1);
  assert.deepEqual(shown.lines, ["No connected Chrome has Graft loaded.\n"]);
});
