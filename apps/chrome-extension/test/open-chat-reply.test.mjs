// graft open: the extension answers native.chat.open with the chat tab's id, in the shape the daemon reads.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { NativeChatOpenedSchema } from "@graft/protocol";

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const CHAT = "968c135b-a48f-4f5e-9223-dff7f9a10a07";

// Whatever the module touches at load and this test does not model answers with an inert value.
function inert() {
  return new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : inert()),
    apply: () => inert(),
  });
}
function withInert(parts) {
  return new Proxy(parts, { get: (target, key) => (key in target ? target[key] : inert()) });
}
globalThis.chrome = withInert({
  runtime: withInert({
    id: OWN,
    getURL: (path = "") => `chrome-extension://${OWN}/${String(path).replace(/^\//, "")}`,
  }),
  tabs: withInert({
    query: async () => [],
    create: async () => ({ id: 42, windowId: 1, status: "complete" }),
    update: async () => undefined,
    get: async () => ({ status: "complete" }),
  }),
  windows: withInert({ getLastFocused: async () => ({ id: 1 }) }),
});

const directory = await mkdtemp(join(tmpdir(), "graft-open-chat-"));
const outfile = join(directory, "bundle.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/native-worker-open-chat.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { chatOpenedMessage, handleOpenChatMessage } = await import(pathToFileURL(outfile).href);
await rm(directory, { recursive: true, force: true });

test("graft open's answer carries the chat tab's id, in the shape the daemon reads", async () => {
  const sent = [];
  const socket = { readyState: 1, send: (text) => sent.push(JSON.parse(text)) };
  const request = { kind: "native.chat.open", chatId: CHAT, active: false };
  assert.equal(handleOpenChatMessage(request, socket), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sent, [{ kind: "native.chat.opened", chatId: CHAT, tabId: 42 }]);
  assert.equal(NativeChatOpenedSchema.safeParse(sent[0]).success, true);
});

test("an answer without a tab id still parses, so the daemon can count the browser", () => {
  const message = chatOpenedMessage(CHAT, undefined);
  assert.deepEqual(message, { kind: "native.chat.opened", chatId: CHAT });
  assert.equal(NativeChatOpenedSchema.safeParse(message).success, true);
});
