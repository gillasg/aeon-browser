import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openChatStore } from "@aeon/store";
import { ChatService } from "../dist/chat-service.js";
import { FakePiPort } from "./fake-pi-port.mjs";

test("a question a running turn waits on can be read and answered while the turn holds the chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-open-session-"));
  const store = openChatStore(directory),
    pi = new FakePiPort();
  const service = new ChatService({ dataDirectory: directory, store, pi });
  // The turn runs until the user answers, the way ask_user does.
  let answer;
  pi.waitForSubmit = new Promise((resolve) => (answer = resolve));
  try {
    const draft = await service.createDraft();
    const turn = service.submitPrompt(draft.chatId, "fill the form");
    while (!pi.handles.get(draft.chatId)) await new Promise((resolve) => setTimeout(resolve, 5));
    const handle = pi.handles.get(draft.chatId);
    handle.extensionUiSnapshot = () => ({ dialogs: [{ requestId: "q1" }], notices: [] });
    handle.answerExtensionUi = (id) => {
      answer();
      return id === "q1";
    };
    const shown = await service.withOpenSession(draft.chatId, (session) =>
      session.extensionUiSnapshot(),
    );
    assert.deepEqual(shown.dialogs, [{ requestId: "q1" }]);
    assert.equal(
      await service.withOpenSession(draft.chatId, (session) => session.answerExtensionUi("q1")),
      true,
    );
    await turn;
  } finally {
    service.projects.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
