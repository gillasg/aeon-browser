import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { ChatService } from "../dist/chat-service.js";
import { ThreadCoordinationService } from "../dist/thread-coordination-service.js";
import { PiSdkSessionAdapter } from "@aeon/pi-adapter";
import { openChatStore } from "@aeon/store";

test("thread tools create chats, deliver idempotently, wait by exact ID, read Pi, title, and fork", async (t) => {
  const runtime = await makeRuntime(t);
  const sender = await runtime.chats.createDraft("Planner");
  const { threadId, deliveryId } = await createAndDeliver(runtime.coordination, sender.chatId);
  await readAndRename(runtime.coordination, runtime.chats, sender.chatId, threadId, deliveryId);
  await forkTranscript(runtime, sender.chatId);
});

async function makeRuntime(t) {
  const root = resolve(await mkdtemp(join(tmpdir(), "aeon-coordination-test-")));
  assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}`));
  const dataDirectory = join(root, "data");
  const sessionDirectory = join(dataDirectory, "pi-sessions");
  const agentDirectory = join(dataDirectory, "pi-agent-config");
  await Promise.all(
    [dataDirectory, sessionDirectory, agentDirectory].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const store = openChatStore(dataDirectory);
  const pi = new PiSdkSessionAdapter({
    sessionDirectory,
    agentDirectory,
    testModel: "local-faux",
  });
  const chats = new ChatService({ dataDirectory, store, pi });
  const coordination = new ThreadCoordinationService(chats, store);
  pi.setThreadToolHost(coordination);
  t.after(async () => {
    coordination.close();
    await pi.closeAll();
    chats.projects.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await coordination.recover();
  return { chats, coordination };
}

async function createAndDeliver(coordination, senderChatId) {
  const created = JSON.parse(
    await coordination.execute(senderChatId, "create-1", "create_thread", {
      title: "Worker",
      idempotencyKey: "worker-create-1",
    }),
  );
  const retried = JSON.parse(
    await coordination.execute(senderChatId, "create-2", "create_thread", {
      title: "Worker",
      idempotencyKey: "worker-create-1",
    }),
  );
  assert.equal(created.thread.chatId, retried.thread.chatId);
  assert.equal(created.thread.status, "draft");

  const sendInput = {
    threadId: created.thread.chatId,
    message: "Review this request and reply with a concise summary.",
    idempotencyKey: "delivery-once",
  };
  const sent = JSON.parse(
    await coordination.execute(senderChatId, "send-1", "send_message_to_thread", sendInput),
  );
  const retry = JSON.parse(
    await coordination.execute(senderChatId, "send-2", "send_message_to_thread", sendInput),
  );
  assert.equal(sent.delivery.deliveryId, retry.delivery.deliveryId);
  const waited = JSON.parse(
    await coordination.execute(senderChatId, "wait-1", "wait_threads", {
      deliveries: [{ threadId: created.thread.chatId, deliveryId: sent.delivery.deliveryId }],
      timeoutMs: 10_000,
    }),
  );
  assert.equal(waited.state, "completed");
  return { threadId: created.thread.chatId, deliveryId: sent.delivery.deliveryId };
}

async function readAndRename(coordination, chats, senderChatId, threadId, deliveryId) {
  const read = JSON.parse(
    await coordination.execute(senderChatId, "read-1", "read_thread", {
      threadId,
      limit: 20,
    }),
  );
  assert.ok(
    read.entries.some((entry) =>
      entry.message?.content.some(
        (block) => block.type === "thread-message" && block.deliveryId === deliveryId,
      ),
    ),
  );
  const renamed = JSON.parse(
    await coordination.execute(senderChatId, "title-1", "set_thread_title", {
      threadId,
      title: "Build reviewer",
    }),
  );
  assert.equal(renamed.thread.title, "Build reviewer");
  assert.ok(
    JSON.parse(await coordination.execute(senderChatId, "list-1", "list_threads", {})).threads
      .length >= 2,
  );
  await assertArchivedThreadHidden(coordination, chats, senderChatId, threadId);
}

async function assertArchivedThreadHidden(coordination, chats, senderChatId, threadId) {
  const archived = chats.updateMetadata(threadId, { archived: true });
  assert.equal(archived.archived, true);
  const listed = JSON.parse(
    await coordination.execute(threadId, "list-archived", "list_threads", {}),
  );
  assert.ok(!listed.threads.some((thread) => thread.chatId === threadId));
  await assert.rejects(
    coordination.execute(threadId, "read-archived", "read_thread", { threadId }),
    /must be reopened/,
  );
  await assert.rejects(
    coordination.execute(senderChatId, "send-archived", "send_message_to_thread", {
      threadId,
      message: "This should remain blocked while archived.",
      idempotencyKey: "send-to-archived",
    }),
    /must be reopened/,
  );
}

async function forkTranscript(runtime, senderChatId) {
  await runtime.chats.submitPrompt(
    senderChatId,
    "Keep this source transcript available for an exact fork.",
  );
  const source = await runtime.chats.getChatView(senderChatId);
  const unsupportedEntry = source.snapshot.entries.find((entry) => entry.message?.role === "user");
  const sourceEntry = source.snapshot.entries.findLast(
    (entry) => entry.message?.role === "assistant",
  );
  assert.ok(unsupportedEntry);
  assert.ok(sourceEntry);
  await verifyUnsupportedFork(runtime, senderChatId, unsupportedEntry);
  const uiFork = await runtime.coordination.forkMessage({
    sourceChatId: senderChatId,
    entryId: sourceEntry.entryId,
    title: "UI fork at assistant",
    idempotencyKey: "ui-fork-assistant",
  });
  assert.equal(uiFork.status, "ready");
  assert.equal(uiFork.chat?.status, "ready");

  const unsupported = JSON.parse(
    await runtime.coordination.execute(senderChatId, "fork-user-only", "fork_thread", {
      threadId: senderChatId,
      entryId: unsupportedEntry.entryId,
      title: "Unsupported user-only fork",
      idempotencyKey: "fork-user-only",
    }),
  );
  assert.equal(unsupported.fork.state, "failed");
  assert.match(unsupported.fork.lastError, /branch has no assistant message/);
  assert.equal((await runtime.chats.getChat(unsupported.fork.targetChatId)).status, "draft");
  const unsupportedRetry = JSON.parse(
    await runtime.coordination.execute(senderChatId, "fork-user-only-retry", "fork_thread", {
      threadId: senderChatId,
      entryId: unsupportedEntry.entryId,
      title: "Unsupported user-only fork",
      idempotencyKey: "fork-user-only",
    }),
  );
  assert.equal(unsupportedRetry.fork.state, "failed");
  assert.equal(unsupportedRetry.fork.targetChatId, unsupported.fork.targetChatId);
  const fork = JSON.parse(
    await runtime.coordination.execute(senderChatId, "fork-1", "fork_thread", {
      threadId: senderChatId,
      entryId: sourceEntry.entryId,
      title: "Fork at selected assistant entry",
      idempotencyKey: "fork-once",
    }),
  );
  assert.equal(fork.fork.state, "ready");
  assert.equal((await runtime.chats.getChat(fork.fork.targetChatId)).status, "ready");
}

async function verifyUnsupportedFork(runtime, senderChatId, unsupportedEntry) {
  const chatCountBeforeUnsupportedFork = runtime.chats.listChats(100).length;
  const uiUnsupported = await runtime.coordination.forkMessage({
    sourceChatId: senderChatId,
    entryId: unsupportedEntry.entryId,
    title: "Unsupported UI fork",
    idempotencyKey: "ui-fork-user-only",
  });
  assert.equal(uiUnsupported.status, "unsupported");
  assert.equal(uiUnsupported.reason, "branch_without_assistant");
  assert.equal(uiUnsupported.targetChatId, null);
  assert.equal(runtime.chats.listChats(100).length, chatCountBeforeUnsupportedFork);
}
