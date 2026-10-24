import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asActivationId, asChatId } from "@aeon/domain";
import { openChatStore } from "@aeon/store";
import { ChatService } from "../dist/chat-service.js";
import { backfillChatOrigins } from "../dist/chat-origin-backfill.js";
import { ThreadCoordinationService } from "../dist/thread-coordination-service.js";
import { FakePiPort } from "./fake-pi-port.mjs";

async function runtime(t) {
  const root = await mkdtemp(join(tmpdir(), "aeon-origin-test-"));
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  const store = openChatStore(dataDirectory);
  const pi = new FakePiPort();
  const chats = new ChatService({ dataDirectory, store, pi });
  const coordination = new ThreadCoordinationService(chats, store);
  t.after(async () => {
    coordination.close();
    chats.projects.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { dataDirectory, store, chats, coordination };
}

test("a chat records what created it, and keeps it", async (t) => {
  const { chats, store } = await runtime(t);
  const cli = await chats.createDraft("From the CLI", undefined, "cli");
  const unknown = await chats.createDraft("Unattributed");
  assert.equal(store.getChat(cli.chatId)?.origin, "cli");
  assert.equal(store.getChat(unknown.chatId)?.origin, "unknown");
  assert.equal(chats.listChats(10)[0]?.origin, "unknown");
  assert.equal(store.setChatOriginIfUnknown(cli.chatId, "agent"), false, "a known origin is kept");
  assert.equal(store.getChat(cli.chatId)?.origin, "cli");
});

test("an agent's thread tool creates an agent chat", async (t) => {
  const { chats, coordination, store } = await runtime(t);
  const sender = await chats.createDraft("Planner", undefined, "user");
  const created = JSON.parse(
    await coordination.execute(sender.chatId, "call-1", "create_thread", {
      title: "Worker",
      idempotencyKey: "worker-1",
    }),
  );
  assert.equal(store.getChat(created.thread.chatId)?.origin, "agent");
  assert.ok(store.listAgentCreatedChatIds().includes(created.thread.chatId));
});

test("listings filter by origin and by the day a chat was created", async (t) => {
  const { dataDirectory, store } = await runtime(t);
  const early = store.createDraft(draft(dataDirectory, "2026-10-01T10:00:00.000Z", "user"));
  const middle = store.createDraft(draft(dataDirectory, "2026-10-02T10:00:00.000Z", "cli"));
  const late = store.createDraft(draft(dataDirectory, "2026-10-03T10:00:00.000Z", "user"));
  assert.equal(store.getChat(early.chatId)?.origin, "user");

  assert.deepEqual(
    store.listChats(10, false, { origin: "cli" }).map((chat) => chat.chatId),
    [middle.chatId],
  );
  assert.deepEqual(
    store
      .listChats(10, false, {
        since: "2026-10-02T00:00:00.000Z",
        until: "2026-10-03T00:00:00.000Z",
      })
      .map((chat) => chat.chatId),
    [middle.chatId],
  );
  assert.deepEqual(
    store
      .listChats(10, false, { origin: "user", since: "2026-10-02T00:00:00.000Z" })
      .map((chat) => chat.chatId),
    [late.chatId],
  );
});

test("the backfill marks only chats with clear evidence", async (t) => {
  const { dataDirectory, store } = await runtime(t);
  const composer = store.createDraft(draft(dataDirectory, "2026-10-01T10:00:00.000Z", "unknown"));
  const sessionFile = join(dataDirectory, "pi-sessions", "composer.jsonl");
  await mkdir(join(dataDirectory, "pi-sessions"), { recursive: true });
  await writeFile(
    sessionFile,
    [
      { type: "session", version: 3 },
      { type: "message", message: { role: "system", content: "" } },
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "custom_message", customType: "pippin.browser-context.v1", content: "page" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const activationId = asActivationId(randomUUID());
  store.beginActivation(composer.chatId, activationId);
  store.attachPiSession(
    composer.chatId,
    activationId,
    { sessionId: activationId, sessionFile },
    false,
  );

  const fromCli = store.createDraft(draft(dataDirectory, "2026-10-02T10:00:00.000Z", "unknown"));
  await mkdir(join(dataDirectory, "cli-runs"), { recursive: true });
  await writeFile(
    join(dataDirectory, "cli-runs", "run.json"),
    JSON.stringify([{ chatId: fromCli.chatId, prompt: "task" }]),
  );

  const sender = store.createDraft(draft(dataDirectory, "2026-10-03T10:00:00.000Z", "user"));
  const agentDraft = draft(dataDirectory, "2026-10-04T10:00:00.000Z", "unknown");
  store.createThreadCreation(
    {
      senderChatId: sender.chatId,
      idempotencyKey: "backfill-thread",
      payloadHash: "hash",
      targetChatId: agentDraft.chatId,
      createdAt: agentDraft.createdAt,
    },
    agentDraft,
  );

  const unknown = store.createDraft(draft(dataDirectory, "2026-10-05T10:00:00.000Z", "unknown"));

  const counts = await backfillChatOrigins(store, dataDirectory);

  assert.deepEqual(counts, { user: 1, cli: 1, agent: 1 });
  assert.equal(store.getChat(composer.chatId)?.origin, "user");
  assert.equal(store.getChat(fromCli.chatId)?.origin, "cli");
  assert.equal(store.getChat(agentDraft.chatId)?.origin, "agent");
  assert.equal(store.getChat(unknown.chatId)?.origin, "unknown", "no evidence, no guess");

  const again = await backfillChatOrigins(store, dataDirectory);
  assert.deepEqual(again, { user: 0, cli: 0, agent: 0 }, "a second pass changes nothing");
});

function draft(dataDirectory, createdAt, origin) {
  const chatId = asChatId(randomUUID());
  return {
    chatId,
    title: "Backfill",
    projectId: null,
    origin,
    pinned: false,
    archived: false,
    workingDirectory: join(dataDirectory, "workspaces", chatId),
    status: "draft",
    activationId: null,
    piReference: null,
    piMaterialized: false,
    createdAt,
    updatedAt: createdAt,
  };
}
