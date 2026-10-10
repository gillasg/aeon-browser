import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { ChatService, closeProjectServices } from "./chat-service-fixture.mjs";
import { PiSdkSessionAdapter } from "@aeon/pi-adapter";
import { openChatStore } from "@aeon/store";
import { createNoProviderSubmitPort } from "./no-provider-submit-port.mjs";

test("real Pi session activation, restart, and attach-crash recovery use one Pi file", async (t) => {
  const dataDirectory = resolve(await mkdtemp(join(tmpdir(), "aeon-real-pi-chat-")));
  assert.ok(dataDirectory.startsWith(`${resolve(tmpdir())}${sep}`));
  const agentDirectory = join(dataDirectory, "pi-agent-config");
  const sessionDirectory = join(dataDirectory, "pi-sessions");
  await mkdir(agentDirectory, { recursive: true });
  let store = openChatStore(dataDirectory);
  let adapter = new PiSdkSessionAdapter({ sessionDirectory, agentDirectory });
  let testPort = createNoProviderSubmitPort(adapter);
  t.after(async () => store.close());
  t.after(async () => adapter.closeAll());
  t.after(() => {
    closeProjectServices(dataDirectory);
    return rm(dataDirectory, { recursive: true, force: true });
  });

  const service = new ChatService({ dataDirectory, store, pi: testPort.port });
  const draft = await service.createDraft();
  assert.equal(await directoryExists(sessionDirectory), false);
  const started = await service.submitPrompt(draft.chatId, "local test prompt");
  assert.equal(started.status, "ready");
  assert.equal(started.piMaterialized, true);
  assert.equal(testPort.submissions.length, 1);
  const reference = started.piReference;
  assert.ok(reference);
  assert.equal(testPort.openedReferences[0]?.sessionId, reference.sessionId);
  const firstEntryIds = (
    await adapter.openOrCreate({
      chatId: draft.chatId,
      activationId: started.activationId,
      workingDirectory: started.workingDirectory,
      reference,
      materialized: true,
    })
  )
    .snapshot()
    .entries.map(({ entryId }) => entryId);
  await adapter.closeAll();
  store.close();

  store = openChatStore(dataDirectory);
  adapter = new PiSdkSessionAdapter({ sessionDirectory, agentDirectory });
  testPort = createNoProviderSubmitPort(adapter);
  const restarted = await new ChatService({ dataDirectory, store, pi: testPort.port }).submitPrompt(
    draft.chatId,
    "second local test prompt",
  );
  assert.deepEqual(restarted.piReference, reference);
  assert.deepEqual(testPort.openedReferences[0], reference);
  const reopenedHandle = await adapter.openOrCreate({
    chatId: draft.chatId,
    activationId: restarted.activationId,
    workingDirectory: restarted.workingDirectory,
    reference,
    materialized: true,
  });
  assert.deepEqual(
    reopenedHandle.snapshot().entries.map(({ entryId }) => entryId),
    firstEntryIds,
  );
  await assertSingleSessionFile(sessionDirectory);
});

test("real Pi file created before SQLite attach is found after daemon restart", async (t) => {
  const dataDirectory = resolve(await mkdtemp(join(tmpdir(), "aeon-pi-crash-test-")));
  assert.ok(dataDirectory.startsWith(`${resolve(tmpdir())}${sep}`));
  const agentDirectory = join(dataDirectory, "pi-agent-config");
  const sessionDirectory = join(dataDirectory, "pi-sessions");
  await mkdir(agentDirectory, { recursive: true });
  let store = openChatStore(dataDirectory);
  let adapter = new PiSdkSessionAdapter({ sessionDirectory, agentDirectory });
  let testPort = createNoProviderSubmitPort(adapter);
  t.after(async () => store.close());
  t.after(async () => adapter.closeAll());
  t.after(() => {
    closeProjectServices(dataDirectory);
    return rm(dataDirectory, { recursive: true, force: true });
  });

  const draft = await new ChatService({ dataDirectory, store, pi: testPort.port }).createDraft();
  const crashingStore = new Proxy(store, {
    get(target, key, receiver) {
      if (key === "attachPiSession")
        return () => {
          throw new Error("simulated process loss");
        };
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(
    new ChatService({ dataDirectory, store: crashingStore, pi: testPort.port }).submitPrompt(
      draft.chatId,
      "first prompt before simulated crash",
    ),
    /simulated process loss/,
  );
  const interrupted = store.getChat(draft.chatId);
  assert.equal(interrupted?.status, "creating");
  const piReferenceBeforeCrash = testPort.openedReferences[0];
  assert.ok(piReferenceBeforeCrash);
  assert.equal(await fileExists(piReferenceBeforeCrash.sessionFile), true);
  await adapter.closeAll();
  store.close();

  store = openChatStore(dataDirectory);
  adapter = new PiSdkSessionAdapter({ sessionDirectory, agentDirectory });
  testPort = createNoProviderSubmitPort(adapter);
  const recovered = await new ChatService({ dataDirectory, store, pi: testPort.port }).submitPrompt(
    draft.chatId,
    "retry after deterministic recovery",
  );
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.activationId, interrupted?.activationId);
  assert.deepEqual(recovered.piReference, piReferenceBeforeCrash);
  await assertSingleSessionFile(sessionDirectory);
});

async function directoryExists(path) {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertSingleSessionFile(directory) {
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".jsonl")).length, 1);
}
