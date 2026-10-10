import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatStore } from "@pippin/store";
import { ChatService } from "../dist/chat-service.js";
import { FakePiPort } from "./fake-pi-port.mjs";

test("startup prepares a whole session invisibly and the first chat adopts its exact identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "aeon-prepared-chat-"));
  const store = openChatStore(root),
    pi = new FakePiPort(),
    resources = [];
  pi.prepareResources = async (cwd) => {
    resources.push(cwd);
  };
  const service = new ChatService({ dataDirectory: root, store, pi });
  try {
    await Promise.all([service.prepareNextDraft(), service.prepareNextDraft()]);
    assert.equal(pi.creations, 1);
    assert.equal(service.listChats().length, 0);
    const [first, second] = await Promise.all([
      service.createDraft("First"),
      service.createDraft("Second"),
    ]);
    assert.equal(first.chatId, pi.opens[0].chatId);
    assert.equal(first.workingDirectory, resources[0]);
    assert.equal(first.activationId, pi.opens[0].activationId);
    assert.equal(first.piReference.sessionId, first.activationId);
    assert.equal(first.status, "ready");
    assert.notEqual(first.chatId, second.chatId);
    await service.submitPrompt(first.chatId, "hello");
    assert.equal(pi.creations, 1);
    assert.deepEqual(pi.prompts, [{ chatId: first.chatId, text: "hello" }]);
    await service.prepareNextDraft();
    assert.equal(pi.creations, 2);
    assert.equal(service.listChats().length, 2);
  } finally {
    service.closePreparation();
    service.projects.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
