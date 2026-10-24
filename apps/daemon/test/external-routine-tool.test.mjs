import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openChatStore } from "@aeon/store";
import { ChatService } from "../dist/chat-service.js";
import { runExternalRoutine } from "../dist/external-routine-tool.js";
import { FakePiPort } from "./fake-pi-port.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aeon-external-routine-"));
  const store = openChatStore(join(root, "data"));
  const chats = new ChatService({ dataDirectory: join(root, "data"), store, pi: new FakePiPort() });
  t.after(async () => {
    chats.projects.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const options = (session, args) => ({
    store,
    createChat: async (title, origin) => chats.createDraft(title, undefined, origin),
    getChat: (chatId) => store.getChat(chatId),
    session,
    args,
  });
  return { store, chats, options };
}

test("an outside agent creates, lists, pauses and deletes only its own routines", async (t) => {
  const { chats, options, store } = await fixture(t);
  const created = await runExternalRoutine(
    options("mcp", {
      action: "create",
      title: "Watch lamps",
      instruction: "Check the lamp listings and tell me about new ones.",
      schedule: "every 15 minutes",
      check: "return true",
      sites: ["shop.example"],
    }),
  );
  assert.ok(created.routineId);
  assert.equal(created.title, "Watch lamps");
  assert.equal(created.enabled, true);
  assert.deepEqual(created.sites, ["shop.example"]);
  assert.equal(created.check, true);
  assert.equal(
    store.getChat(created.chatId)?.origin,
    "mcp",
    "a new chat carries the caller's origin",
  );

  const mcpList = await runExternalRoutine(options("mcp", { action: "list" }));
  assert.deepEqual(
    mcpList.map((routine) => routine.routineId),
    [created.routineId],
  );
  assert.deepEqual(await runExternalRoutine(options("cli", { action: "list" })), []);

  await assert.rejects(
    () => runExternalRoutine(options("cli", { action: "pause", routineId: created.routineId })),
    /not created by cli/,
  );
  const paused = await runExternalRoutine(
    options("mcp", { action: "pause", routineId: created.routineId }),
  );
  assert.equal(paused.enabled, false);

  await assert.rejects(
    () => runExternalRoutine(options("cli", { action: "delete", routineId: created.routineId })),
    /not created by cli/,
  );
  assert.deepEqual(
    await runExternalRoutine(options("mcp", { action: "delete", routineId: created.routineId })),
    { routineId: created.routineId, deleted: true },
  );
  assert.equal(store.getRoutine(created.routineId)?.deletedAt !== null, true);

  // A routine in a chat the user made is the user's: an outside agent cannot manage it.
  const userChat = await chats.createDraft("User chat", undefined, "user");
  const now = new Date();
  const userRoutine = store.createRoutine({
    routineId: randomUUID(),
    chatId: userChat.chatId,
    title: "User routine",
    instruction: "Check something.",
    check: null,
    sites: [],
    schedule: { kind: "interval", everyMinutes: 15, anchorUtc: now.toISOString(), timeZone: "UTC" },
    nextDueAt: new Date(now.getTime() + 900_000).toISOString(),
    requiredBrowserInstanceId: null,
    enabled: true,
    deletedAt: null,
    revision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  await assert.rejects(
    () => runExternalRoutine(options("mcp", { action: "pause", routineId: userRoutine.routineId })),
    /not created by mcp/,
  );
});
