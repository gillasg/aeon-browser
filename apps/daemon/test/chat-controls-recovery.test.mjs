import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openChatStore } from "@aeon/store";
import { ChatService } from "../dist/chat-service.js";
import { FakePiPort } from "./fake-pi-port.mjs";

const unavailable =
  'opencode-go/deepseek-v4.1-flash isn\'t available. Sign in to opencode-go again from the model picker ("Add or manage models…").';

class FlakyPiPort extends FakePiPort {
  constructor(failures) {
    super();
    this.failures = failures;
  }
  async openOrCreate(input) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(unavailable);
    }
    return super.openOrCreate(input);
  }
}

test("a Chat that failed to start retries controls and reports the model error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-controls-recovery-"));
  const store = openChatStore(directory);
  const port = new FlakyPiPort(2);
  const service = new ChatService({ dataDirectory: directory, store, pi: port });
  try {
    const chat = await service.createDraft("Model gone");
    await assert.rejects(service.submitPrompt(chat.chatId, "hello"), /isn't available/);
    // The page opens after the failure: controls asks again and gets the same reason, not "no controls".
    await assert.rejects(service.getControls(chat.chatId), /isn't available/);
    const controls = await service.getControls(chat.chatId);
    assert.equal(controls.effectiveModel, null);
    assert.equal(port.failures, 0);
    assert.equal(port.opens.length, 1);
  } finally {
    service.projects.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
