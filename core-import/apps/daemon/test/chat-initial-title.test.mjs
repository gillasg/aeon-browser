import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatService, closeProjectServices } from "./chat-service-fixture.mjs";
import { openChatStore } from "@aeon/store";
import { FakePiPort } from "./fake-pi-port.mjs";

test("first prompt titles a thread even after initial model selection activates Pi", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-initial-title-"));
  const store = openChatStore(directory);
  try {
    const pi = new FakePiPort();
    const service = new ChatService({ dataDirectory: directory, store, pi });
    const draft = await service.createDraft();
    await service.setModel(draft.chatId, "fixture", "fixture");
    assert.equal(service.getChat(draft.chatId).status, "ready");
    assert.equal(service.getChat(draft.chatId).piMaterialized, false);
    const handle = pi.handles.get(draft.chatId);
    const initialSnapshot = handle.snapshot;
    handle.snapshot = () => ({ ...initialSnapshot(), materialized: true });
    store.markPiMaterialized(draft.chatId, handle.reference.sessionId);
    assert.equal(service.getChat(draft.chatId).piMaterialized, true);
    await service.submitPrompt(draft.chatId, "Scroll the Yahoo page");
    assert.equal(service.getChat(draft.chatId).title, "Scroll the Yahoo page");
    await service.submitPrompt(draft.chatId, "Another request");
    assert.equal(service.getChat(draft.chatId).title, "Scroll the Yahoo page");
  } finally {
    closeProjectServices(directory);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
