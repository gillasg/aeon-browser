import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers";
import { DaemonUiRequestSchema } from "@aeon/protocol";
import { createAndSubmitChat } from "../dist/chat-first-submit.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openChatStore } from "@aeon/store";
import { ChatService } from "../dist/chat-service.js";
import { FakePiPort } from "./fake-pi-port.mjs";

function fixture() {
  const messages = [],
    submissions = [],
    deleted = [],
    origins = [];
  const chat = {
    chatId: randomUUID(),
    title: "New Chat",
    projectId: null,
    origin: "user",
    pinned: false,
    archived: false,
    status: "draft",
    workingDirectory: "C:/local-workspace",
    activationId: null,
    piReference: null,
    piMaterialized: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let finish;
  const service = {
    createDraft: async (_title, projectId, origin) => {
      origins.push(origin);
      return { ...chat, projectId: projectId ?? null, origin };
    },
    submitPrompt: (...args) => {
      submissions.push(args);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    deleteChat: async (id) => deleted.push(id),
    getChatView: async () => ({ snapshot: { runState: "idle" } }),
  };
  const socket = { readyState: 1, send: (data) => messages.push(JSON.parse(data)) };
  const request = DaemonUiRequestSchema.parse({
    kind: "command",
    operation: "chat.create",
    requestId: randomUUID(),
    payload: {
      projectId: randomUUID(),
      initialSubmit: {
        text: "hello",
        model: { provider: "fixture", id: "one" },
        thinkingLevel: "low",
        attachments: [],
        browserContexts: [],
      },
    },
  });
  return {
    service,
    socket,
    request,
    messages,
    submissions,
    deleted,
    origins,
    finish: () => finish(),
  };
}
test("one create command accepts and starts the first prompt before session setup finishes", async () => {
  const f = fixture();
  await createAndSubmitChat(f.socket, f.service, f.request);
  assert.deepEqual(
    f.messages.map((message) => message.kind),
    ["command.completed", "command.started"],
  );
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0][0], f.messages[0].result.chat.chatId);
  assert.deepEqual(f.submissions[0][1], { text: "hello", attachments: [], browserContexts: [] });
  assert.equal(f.submissions[0][2].thinkingLevel, "low");
  assert.equal(f.messages[0].result.chat.projectId, f.request.payload.projectId);
  assert.deepEqual(f.origins, ["user"], "a first prompt from the UI is a user chat");
  for (const key of ["workingDirectory", "activationId", "piReference", "piMaterialized"])
    assert.equal(key in f.messages[0].result.chat, false);
  // Navigation closes the creator socket; the accepted prompt continues without replay.
  f.socket.readyState = 3;
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.submissions.length, 1);
});
test("stale browser context rejects the new prompt and cleans up its unstarted draft", async () => {
  const f = fixture();
  f.request.payload.initialSubmit.browserContexts = [{ target: {}, url: "https://example.com" }];
  await assert.rejects(
    createAndSubmitChat(f.socket, f.service, f.request, () => "stale"),
    /selected tab/,
  );
  assert.equal(f.submissions.length, 0);
  assert.equal(f.deleted.length, 1);
  assert.equal(f.messages.length, 0);
});

test("first submission projects an actual stored ChatRecord and reaches Pi", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-real-first-submit-"));
  const store = openChatStore(directory),
    pi = new FakePiPort();
  const service = new ChatService({ dataDirectory: directory, store, pi });
  const f = fixture();
  delete f.request.payload.projectId;
  let settled;
  const finished = new Promise((resolve) => {
    settled = resolve;
  });
  const socket = {
    readyState: 1,
    send: (data) => {
      const message = JSON.parse(data);
      f.messages.push(message);
      if (message.kind === "command.settled") settled(message);
    },
  };
  try {
    await createAndSubmitChat(socket, service, f.request);
    const result = await finished;
    assert.equal(result.state, "settled");
    const chat = f.messages[0].result.chat;
    assert.equal(typeof store.getChat(chat.chatId).workingDirectory, "string");
    assert.equal("workingDirectory" in chat, false);
    assert.deepEqual(pi.prompts, [{ chatId: chat.chatId, text: "hello" }]);
  } finally {
    service.projects.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
