import assert from "node:assert/strict";
import test from "node:test";
import { executePiUiAction } from "../dist/pi-ui-commands.js";

test("native UI fork projects a closed summary instead of leaking its internal chat record", async () => {
  const source = "00000000-0000-4000-8000-000000000001";
  const target = "00000000-0000-4000-8000-000000000002";
  const timestamp = new Date().toISOString();
  let sent;
  const socket = {
    readyState: 1,
    send(value) {
      sent = JSON.parse(value);
    },
  };
  const coordination = {
    async forkMessage() {
      return {
        status: "ready",
        targetChatId: target,
        reason: null,
        chat: {
          chatId: target,
          title: "Branch",
          projectId: null,
          pinned: false,
          archived: false,
          status: "ready",
          createdAt: timestamp,
          updatedAt: timestamp,
          workingDirectory: "C:/fixture",
          activationId: null,
          piMaterialized: true,
          piReference: { sessionId: "private-session", sessionFile: "C:/private/transcript.jsonl" },
        },
      };
    },
  };
  await executePiUiAction(
    socket,
    {},
    {
      kind: "command",
      requestId: "00000000-0000-4000-8000-000000000003",
      operation: "chat.fork-message",
      payload: { chatId: source, entryId: "entry-1" },
    },
    coordination,
  );
  assert.equal(sent.kind, "command.completed");
  assert.equal(sent.result.status, "ready");
  assert.equal(sent.result.chat.chatId, target);
  assert.equal("piReference" in sent.result.chat, false);
  assert.equal("workingDirectory" in sent.result.chat, false);
});
