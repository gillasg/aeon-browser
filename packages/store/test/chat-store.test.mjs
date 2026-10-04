import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { asActivationId, asChatId } from "@pippin/domain";
import { openChatStore } from "../dist/index.js";

test("draft metadata is durable without a transcript or Pi reference table", async (t) => {
  const dataDirectory = await makeTemp();
  let store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const chatId = asChatId("be4f2302-cc59-4f4d-97dc-6b57d38ca7e7");
  const now = new Date().toISOString();

  store.createDraft({
    chatId,
    title: "New Chat",
    projectId: null,
    pinned: false,
    archived: false,
    workingDirectory: join(dataDirectory, "workspaces", chatId),
    status: "draft",
    activationId: null,
    piReference: null,
    piMaterialized: false,
    createdAt: now,
    updatedAt: now,
  });
  store.close();

  const reader = new Database(join(dataDirectory, "pippin.sqlite"), { readonly: true });
  const tables = reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.deepEqual(tables.map(({ name }) => name).sort(), [
    "capability_audit",
    "chats",
    "deleted_chats",
    "routine_runs",
    "routines",
    "schema_migrations",
    "thread_creations",
    "thread_deliveries",
    "thread_forks",
  ]);
  reader.close();

  store = openChatStore(dataDirectory);
  const chat = store.getChat(chatId);
  assert.equal(chat?.status, "draft");
  assert.equal(chat?.piReference, null);
  assert.equal(chat?.activationId, null);
  assert.equal(chat?.pinned, false);
  assert.equal(chat?.archived, false);
});

test("Chat title, pin, and archive metadata persist without adding transcript tables", async (t) => {
  const dataDirectory = await makeTemp();
  let store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const chatId = asChatId("b0fe591e-7d3e-4c07-8f5b-9b29105eae27");
  const now = new Date().toISOString();
  store.createDraft({
    chatId,
    title: "Research notes",
    projectId: null,
    pinned: false,
    archived: false,
    workingDirectory: join(dataDirectory, "workspaces", chatId),
    status: "draft",
    activationId: null,
    piReference: null,
    piMaterialized: false,
    createdAt: now,
    updatedAt: now,
  });
  store.updateMetadata(chatId, { title: "Model notes", pinned: true });
  store.updateMetadata(chatId, { archived: true });
  assert.equal(store.listChats(10).length, 0);
  store.close();

  store = openChatStore(dataDirectory);
  const archived = store.listChats(10, true);
  assert.equal(archived[0]?.title, "Model notes");
  assert.equal(archived[0]?.pinned, true);
  assert.equal(archived[0]?.archived, true);
  const reader = new Database(join(dataDirectory, "pippin.sqlite"), { readonly: true });
  const tables = reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.deepEqual(tables.map(({ name }) => name).sort(), [
    "capability_audit",
    "chats",
    "deleted_chats",
    "routine_runs",
    "routines",
    "schema_migrations",
    "thread_creations",
    "thread_deliveries",
    "thread_forks",
  ]);
  reader.close();
});

test("activation IDs and Pi references survive close and reopen", async (t) => {
  const dataDirectory = await makeTemp();
  let store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const chatId = asChatId("96a80675-7ef5-4660-9bb8-2082d12de86a");
  const now = new Date().toISOString();
  store.createDraft({
    chatId,
    title: "Recovery",
    projectId: null,
    pinned: false,
    archived: false,
    workingDirectory: join(dataDirectory, "workspace"),
    status: "draft",
    activationId: null,
    piReference: null,
    piMaterialized: false,
    createdAt: now,
    updatedAt: now,
  });
  const activationId = asActivationId("70d2f5b8-7508-4e41-83bb-1b43b84b1e91");
  store.beginActivation(chatId, activationId);
  const reference = {
    sessionId: activationId,
    sessionFile: join(dataDirectory, "pi", "one.jsonl"),
  };
  store.attachPiSession(chatId, activationId, reference, false);
  store.close();

  store = openChatStore(dataDirectory);
  const recovered = store.getChat(chatId);
  assert.equal(recovered?.status, "ready");
  assert.equal(recovered?.activationId, activationId);
  assert.deepEqual(recovered?.piReference, reference);
  assert.equal(recovered?.piMaterialized, false);
});

test("thread creation and delivery intents are durable, idempotent, and body-free", async (t) => {
  const dataDirectory = await makeTemp();
  const store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const senderChatId = asChatId("7c789e26-bc4f-46cd-9b0f-2a4a140a3c9f");
  const recipientChatId = asChatId("4d121e25-78a1-4c84-822b-525607520ebb");
  const now = new Date().toISOString();
  store.createDraft(makeDraft(dataDirectory, senderChatId, now));
  const intent = {
    senderChatId,
    idempotencyKey: "create-once",
    payloadHash: "create-hash",
    targetChatId: recipientChatId,
    createdAt: now,
  };
  assert.equal(
    store.createThreadCreation(intent, makeDraft(dataDirectory, recipientChatId, now)).targetChatId,
    recipientChatId,
  );
  assert.equal(
    store.createThreadCreation(intent, makeDraft(dataDirectory, recipientChatId, now)).targetChatId,
    recipientChatId,
  );
  const delivery = {
    deliveryId: "c13f75df-3f94-4dc6-b998-07444946918c",
    idempotencyKey: "send-once",
    senderChatId,
    recipientChatId,
    senderToolCallId: "tool-call-1",
    payloadHash: "message-hash",
    mode: "followUp",
    inReplyTo: null,
    createdAt: now,
  };
  assert.equal(store.createThreadDelivery(delivery).created, true);
  assert.equal(store.createThreadDelivery(delivery).created, false);
  store.updateThreadDelivery(delivery.deliveryId, { state: "submitting", attempt: 1 }, now);
  store.close();

  const reader = new Database(join(dataDirectory, "pippin.sqlite"), { readonly: true });
  const columns = reader.prepare("PRAGMA table_info(thread_deliveries)").all();
  assert.equal(
    columns.some(({ name }) => name === "message"),
    false,
  );
  assert.equal(
    reader
      .prepare("SELECT COUNT(*) AS count FROM thread_deliveries WHERE state = 'submitting'")
      .get().count,
    1,
  );
  reader.close();

  const reopened = openChatStore(dataDirectory);
  assert.equal(
    reopened.getThreadCreation(senderChatId, "create-once")?.targetChatId,
    recipientChatId,
  );
  assert.equal(reopened.getThreadDelivery(delivery.deliveryId)?.state, "submitting");
  reopened.close();
});

test("a detached fork attaches its native Pi session to the target Chat atomically", async (t) => {
  const dataDirectory = await makeTemp();
  const store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const senderChatId = asChatId("65a6285c-6728-4e0b-880a-bb3760415398");
  const sourceChatId = asChatId("6c8c5e71-f2fc-4983-9417-8117146bd2c3");
  const targetChatId = asChatId("52e383c6-341a-4409-aa2d-8d62fda31084");
  const now = new Date().toISOString();
  store.createDraft(makeDraft(dataDirectory, senderChatId, now));
  store.createDraft(makeDraft(dataDirectory, sourceChatId, now));
  const intent = store.createThreadFork(
    {
      senderChatId,
      idempotencyKey: "fork-once",
      payloadHash: "fork-hash",
      sourceChatId,
      sourceEntryId: "entry-exact",
      targetChatId,
      title: "Detached child",
      createdAt: now,
    },
    makeDraft(dataDirectory, targetChatId, now),
  );
  assert.equal(intent.state, "pending");
  const reference = {
    sessionId: "a63f436c-b021-4325-8e88-197bbbfef0a3",
    sessionFile: join(dataDirectory, "fork.jsonl"),
  };
  const attached = store.attachThreadForkedChat(senderChatId, "fork-once", reference);
  assert.equal(attached.state, "ready");
  assert.equal(store.getChat(targetChatId)?.status, "ready");
  assert.deepEqual(store.getChat(targetChatId)?.piReference, reference);
});

test("a known unsupported Pi fork is terminal and leaves its target as a draft", async (t) => {
  const dataDirectory = await makeTemp();
  const store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const senderChatId = asChatId("65a6285c-6728-4e0b-880a-bb3760415398");
  const sourceChatId = asChatId("6c8c5e71-f2fc-4983-9417-8117146bd2c3");
  const targetChatId = asChatId("52e383c6-341a-4409-aa2d-8d62fda31084");
  const now = new Date().toISOString();
  store.createDraft(makeDraft(dataDirectory, senderChatId, now));
  store.createDraft(makeDraft(dataDirectory, sourceChatId, now));
  store.createThreadFork(
    {
      senderChatId,
      idempotencyKey: "unsupported-fork",
      payloadHash: "unsupported-hash",
      sourceChatId,
      sourceEntryId: "user-entry-only",
      targetChatId,
      title: "Unsupported fork",
      createdAt: now,
    },
    makeDraft(dataDirectory, targetChatId, now),
  );
  const failed = store.updateThreadFork(senderChatId, "unsupported-fork", {
    state: "failed",
    piReference: null,
    updatedAt: now,
    lastError: "Pi cannot persist a branch without an assistant message.",
  });
  assert.equal(failed.state, "failed");
  assert.equal(store.getChat(targetChatId)?.status, "draft");
  assert.equal(store.listOpenThreadForks().length, 0);
});

async function makeTemp() {
  const root = resolve(await mkdtemp(join(tmpdir(), "pippin-store-test-")));
  assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}`));
  return root;
}

function makeDraft(dataDirectory, chatId, now) {
  return {
    chatId,
    title: "Thread test",
    projectId: null,
    pinned: false,
    archived: false,
    workingDirectory: join(dataDirectory, "workspaces", chatId),
    status: "draft",
    activationId: null,
    piReference: null,
    piMaterialized: false,
    createdAt: now,
    updatedAt: now,
  };
}
