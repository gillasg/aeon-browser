import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DaemonUiRequestSchema } from "@aeon/protocol";
import { beginSubmit } from "../dist/dev-chat-submit.js";

test("a first prompt can carry the model and thinking level the caller chose", async () => {
  const calls = [];
  const messages = [];
  const service = {
    submitPrompt: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
    getChatView: async () => ({ snapshot: { runState: "idle" } }),
  };
  const socket = { readyState: 1, send: (data) => messages.push(JSON.parse(data)) };
  const request = DaemonUiRequestSchema.parse({
    kind: "command",
    requestId: randomUUID(),
    operation: "chat.submit",
    payload: {
      chatId: randomUUID(),
      text: "Find the price",
      selection: { model: { provider: "aeon-fixture", id: "model-one" }, thinkingLevel: "low" },
    },
  });
  beginSubmit(socket, service, request);
  for (let i = 0; i < 50 && !messages.some((message) => message.kind === "command.settled"); i++)
    await new Promise((done) => setTimeout(done, 5));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2], request.payload.selection);
  assert.deepEqual(
    messages.map((message) => message.kind),
    ["command.started", "command.settled"],
  );
});
