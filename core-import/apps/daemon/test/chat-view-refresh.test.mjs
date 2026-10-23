import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatService, closeProjectServices } from "./chat-service-fixture.mjs";
import { openChatStore } from "@aeon/store";
import { FakePiPort } from "./fake-pi-port.mjs";

test("native branch replacement reaches all subscribers with a fresh cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-view-refresh-"));
  const store = openChatStore(directory);
  try {
    const service = new ChatService({ dataDirectory: directory, store, pi: new FakePiPort() });
    const draft = await service.createDraft();
    await service.submitPrompt(draft.chatId, "initial prompt");
    const view = await service.getChatView(draft.chatId);
    const full = [],
      panel = [];
    const first = service.subscribeFrom(draft.chatId, view.cursor, (event) => full.push(event));
    const second = service.subscribeFrom(draft.chatId, view.cursor, (event) => panel.push(event));
    const refreshed = await service.refreshViews(draft.chatId);
    assert.equal(full.length, 1);
    assert.deepEqual(full, panel);
    assert.equal(full[0].event.kind, "view-replaced");
    assert.deepEqual(full[0].event.entries, refreshed.snapshot.entries);
    assert.deepEqual(full[0].cursor, refreshed.cursor);
    assert.ok(refreshed.cursor.revision > view.cursor.revision);
    first.unsubscribe();
    second.unsubscribe();
  } finally {
    closeProjectServices(directory);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
