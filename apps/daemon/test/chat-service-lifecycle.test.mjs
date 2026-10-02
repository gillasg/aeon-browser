import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { ChatService } from "../dist/chat-service.js";
import { openChatStore } from "@pippin/store";
import { FakePiPort } from "./fake-pi-port.mjs";

test("draft creation does not start Pi; first submit attaches one session", async (t) => {
  const dataDirectory = await makeTemp();
  const store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const pi = new FakePiPort();
  const service = new ChatService({ dataDirectory, store, pi });
  const draft = await service.createDraft();
  assert.equal(draft.status, "draft");
  assert.equal(draft.piReference, null);
  assert.equal(pi.opens.length, 0);

  const started = await service.submitPrompt(draft.chatId, "First prompt");
  assert.equal(started.title, "First prompt");
  assert.equal(started.status, "ready");
  assert.equal(started.piReference?.sessionId, started.activationId);
  assert.equal(pi.opens.length, 1);
  assert.deepEqual(
    pi.prompts.map(({ text }) => text),
    ["First prompt"],
  );
});

test("same-path concurrent first submits share one activation and Pi session", async (t) => {
  const dataDirectory = await makeTemp();
  const store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const pi = new FakePiPort();
  const service = new ChatService({ dataDirectory, store, pi });
  const draft = await service.createDraft();

  await Promise.all([
    service.submitPrompt(draft.chatId, "first concurrent prompt"),
    service.submitPrompt(draft.chatId, "second concurrent prompt"),
  ]);

  assert.equal(pi.creations, 1);
  assert.equal(new Set(pi.prompts.map(({ chatId }) => chatId)).size, 1);
  assert.deepEqual(
    new Set(pi.prompts.map(({ text }) => text)),
    new Set(["first concurrent prompt", "second concurrent prompt"]),
  );
  assert.equal(store.getChat(draft.chatId)?.status, "ready");
});

test("Pi follow-up and steer input bypass the active prompt gate and expose its queue", async (t) => {
  const dataDirectory = await makeTemp();
  const store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const pi = new FakePiPort();
  let finishPrompt;
  pi.waitForSubmit = new Promise((resolvePrompt) => {
    finishPrompt = resolvePrompt;
  });
  const service = new ChatService({ dataDirectory, store, pi });
  const draft = await service.createDraft();
  const activePrompt = service.submitPrompt(draft.chatId, "active run");
  await waitUntil(() => pi.prompts.length === 1);

  await Promise.race([
    service.queueInput(draft.chatId, { text: "Do this next" }, "followUp"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Queue input waited for the prompt gate.")), 1000),
    ),
  ]);
  await service.queueInput(draft.chatId, { text: "Consider this now" }, "steer");
  const controls = await service.getControls(draft.chatId);
  assert.deepEqual(controls?.followUpQueue, ["Do this next"]);
  assert.deepEqual(controls?.steeringQueue, ["Consider this now"]);
  finishPrompt();
  await activePrompt;
});

test("a crash between Pi creation and SQLite attachment reuses its journal ID", async (t) => {
  const dataDirectory = await makeTemp();
  let store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const piBeforeCrash = new FakePiPort();
  const draft = await new ChatService({ dataDirectory, store, pi: piBeforeCrash }).createDraft();
  const failingStore = new Proxy(store, {
    get(target, key, receiver) {
      if (key === "attachPiSession")
        return () => {
          throw new Error("simulated crash boundary");
        };
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(
    new ChatService({ dataDirectory, store: failingStore, pi: piBeforeCrash }).submitPrompt(
      draft.chatId,
      "resume",
    ),
    /simulated crash boundary/,
  );
  const interrupted = store.getChat(draft.chatId);
  assert.equal(interrupted?.status, "creating");
  const activationId = interrupted?.activationId;
  store.close();

  store = openChatStore(dataDirectory);
  const piAfterRestart = new FakePiPort();
  const recovered = await new ChatService({
    dataDirectory,
    store,
    pi: piAfterRestart,
  }).submitPrompt(draft.chatId, "resume");
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.activationId, activationId);
  assert.equal(piAfterRestart.opens[0]?.activationId, activationId);
});

test("reopening the daemon store resolves the same Pi reference", async (t) => {
  const dataDirectory = await makeTemp();
  let store = openChatStore(dataDirectory);
  t.after(() => store.close());
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const pi = new FakePiPort();
  const service = new ChatService({ dataDirectory, store, pi });
  const chat = await service.createDraft();
  const started = await service.submitPrompt(chat.chatId, "hello");
  store.close();

  store = openChatStore(dataDirectory);
  const reopened = store.getChat(chat.chatId);
  assert.deepEqual(reopened?.piReference, started.piReference);
  assert.equal(reopened?.activationId, started.activationId);
});

async function makeTemp() {
  const root = resolve(await mkdtemp(join(tmpdir(), "pippin-daemon-test-")));
  assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}`));
  return root;
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Pi prompt did not reach the active state.");
}
