import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { asActivationId, asChatId, PiSessionUnavailableError } from "@aeon/domain";
import { PiSdkSessionAdapter } from "../dist/index.js";

test("pinned Pi creates one stable session and flushes it without provider access", async (t) => {
  assert.equal(VERSION, "0.99.1");
  const paths = await makeSandbox();
  const input = makeInput(paths);
  const firstAdapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
  });
  t.after(() => firstAdapter.closeAll());
  t.after(() => removeTree(paths.root));
  const [first, concurrent] = await Promise.all([
    firstAdapter.openOrCreate(input),
    firstAdapter.openOrCreate(input),
  ]);
  assert.equal(first.reference.sessionId, input.activationId);
  assert.equal(concurrent.reference.sessionId, first.reference.sessionId);
  assert.equal(first.snapshot().materialized, true);
  assert.equal(first.snapshot().entries.length, 1);
  assert.equal(
    (await readdir(paths.sessionDirectory)).filter((name) => name.endsWith(".jsonl")).length,
    1,
  );
  await firstAdapter.closeAll();

  const afterRestart = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
  });
  t.after(() => afterRestart.closeAll());
  const recovered = await afterRestart.openOrCreate({
    ...input,
    reference: first.reference,
    materialized: true,
  });
  assert.equal(recovered.reference.sessionId, first.reference.sessionId);
  assert.equal(recovered.snapshot().materialized, true);
  assert.equal(recovered.reference.sessionFile, first.reference.sessionFile);
  await afterRestart.closeAll();
});

test("Pi's persisted reference reopens the same entries without a transcript mirror", async (t) => {
  const paths = await makeSandbox();
  const input = makeInput(paths);
  const manager = SessionManager.create(paths.workingDirectory, paths.sessionDirectory, {
    id: input.activationId,
  });
  const metadataEntryId = manager.appendSessionInfo("Pi persistence fixture");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);

  const firstAdapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
  });
  t.after(() => firstAdapter.closeAll());
  t.after(() => removeTree(paths.root));
  const reference = { sessionId: input.activationId, sessionFile };
  assert.ok((await readdir(paths.sessionDirectory)).includes(sessionFile.split(/[\\/]/).at(-1)));
  const opened = await firstAdapter.openOrCreate({ ...input, reference, materialized: true });
  const firstSnapshot = opened.snapshot();
  assert.equal(firstSnapshot.materialized, true);
  assert.ok(firstSnapshot.entries.some(({ entryId }) => entryId === metadataEntryId));
  await firstAdapter.closeAll();

  const restartedAdapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
  });
  t.after(() => restartedAdapter.closeAll());
  const reopened = await restartedAdapter.openOrCreate({ ...input, reference, materialized: true });
  const secondSnapshot = reopened.snapshot();
  assert.deepEqual(secondSnapshot.entries, firstSnapshot.entries);
  assert.equal(
    (await readdir(paths.sessionDirectory)).filter((name) => name.endsWith(".jsonl")).length,
    1,
  );
  assert.doesNotMatch(
    await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
    /AgentSession|SessionManager|SessionEntry/,
  );
  await restartedAdapter.closeAll();
});

test("local faux model streams through real Pi prompt and persists exact entry IDs", async (t) => {
  const fixture = await createFixturePromptSession(t);
  const controls = fixture.session.controls();
  assert.equal(controls.effectiveModel?.provider, "aeon-local-fixture");
  assert.equal(controls.effectiveModel?.id, "read-only-stream");
  assert.ok(controls.availableModels.some(({ id }) => id === "read-only-stream"));
  assert.equal(controls.active, false);
  await fixture.session.submit({
    text: "List this local workspace, then summarize it.",
    attachments: [
      { name: "context.txt", mimeType: "text/plain", data: "Y29udGV4dA==", byteLength: 7 },
    ],
  });
  fixture.unsubscribe();
  const snapshot = fixture.session.snapshot();
  assertFixtureContent(snapshot);
  assertFixtureEvents(fixture.events, snapshot);
  const match = await fixture.adapter.searchTranscript(
    snapshot.reference,
    fixture.input.workingDirectory,
    "local fixture response",
  );
  assert.equal(match?.role, "assistant");
  assert.match(match?.excerpt ?? "", /Local fixture response 1/);
  await assertFixtureRestore(fixture, snapshot, t);
});

test("browser context stays a separate Pi-owned record beside unchanged user text", async (t) => {
  const fixture = await createFixturePromptSession(t);
  const context = {
    contextId: randomUUID(),
    kind: "selection",
    capturedAt: new Date().toISOString(),
    target: {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabId: 19,
      tabIncarnation: randomUUID(),
    },
    url: "https://example.test/article",
    title: "Example article",
    selectedText: "This captured text stays linked to the page it came from.",
  };
  const prompt = "What does this paragraph mean?";
  await fixture.session.submit({ text: prompt, browserContext: context });
  const snapshot = fixture.session.snapshot();
  const userEntry = snapshot.entries.find(
    ({ message }) =>
      message?.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text === prompt),
  );
  const contextEntry = snapshot.entries.find(
    ({ message }) =>
      message?.role === "custom" &&
      message.content.some((block) => block.type === "browser-context"),
  );
  assert.ok(userEntry);
  assert.ok(contextEntry);
  assert.equal(contextEntry.parentEntryId, userEntry.entryId);
  assert.deepEqual(
    contextEntry.message.content.find((block) => block.type === "browser-context")?.record,
    context,
  );
  await assertFixtureRestore(fixture, snapshot, t);
});

async function createFixturePromptSession(t) {
  const paths = await makeSandbox();
  const input = makeInput(paths);
  const adapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
    testModel: "local-faux",
  });
  t.after(() => adapter.closeAll());
  t.after(() => removeTree(paths.root));
  const session = await adapter.openOrCreate(input);
  const events = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  return { paths, input, adapter, session, events, unsubscribe };
}

function assertFixtureContent(snapshot) {
  const messages = snapshot.entries.flatMap(({ message }) => (message ? [message] : []));
  const customMessages = messages.filter(({ role }) => role === "custom");
  const ids = snapshot.entries.map(({ entryId }) => entryId);
  assert.equal(snapshot.runState, "idle");
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(customMessages.length > 0);
  assert.ok(customMessages.every(({ content }) => content.length === 0));
  assert.ok(
    messages.some(({ role, content }) =>
      hasText(role === "user" ? content : [], "List this local workspace"),
    ),
  );
  assert.ok(
    messages.some(({ role, content }) =>
      hasText(role === "user" ? content : [], "Attached file: context.txt"),
    ),
  );
  const toolCall = messages
    .flatMap(({ content }) => content)
    .find(({ type }) => type === "tool-call");
  assert.ok(toolCall);
  assert.equal(toolCall.toolName, "ls");
  assert.ok(
    messages.some(
      ({ role, content }) => role === "assistant" && hasText(content, "Local fixture response 1"),
    ),
  );
}

function hasText(content, expected) {
  return content.some((block) => block.type === "text" && block.text.includes(expected));
}

function assertFixtureEvents(events, snapshot) {
  const toolCall = snapshot.entries
    .flatMap(({ message }) => message?.content ?? [])
    .find(({ type }) => type === "tool-call");
  assert.ok(events.some(({ kind }) => kind === "message-update"));
  assert.ok(
    events.some(
      ({ kind, toolCallId }) => kind === "tool-start" && toolCallId === toolCall.toolCallId,
    ),
  );
  assert.ok(
    events.some(
      ({ kind, toolCallId }) => kind === "tool-end" && toolCallId === toolCall.toolCallId,
    ),
  );
  const committed = events.filter(({ kind }) => kind === "entry-added");
  const customEventMessages = events
    .filter(
      ({ kind }) => kind === "message-start" || kind === "message-update" || kind === "message-end",
    )
    .map(({ message }) => message)
    .filter(({ role }) => role === "custom");
  assert.ok(customEventMessages.every(({ content }) => content.length === 0));
  const ids = snapshot.entries.map(({ entryId }) => entryId);
  assert.deepEqual(
    committed.map(({ entry }) => entry.entryId),
    ids.slice(-committed.length),
    JSON.stringify(events.map(({ kind }) => kind)),
  );
  assert.ok(
    events
      .filter(({ kind }) => kind === "message-update")
      .every((event) => !("entryId" in event.message)),
  );
}

async function assertFixtureRestore(fixture, snapshot, t) {
  await fixture.adapter.closeAll();
  const restartedAdapter = new PiSdkSessionAdapter({
    sessionDirectory: fixture.paths.sessionDirectory,
    agentDirectory: fixture.paths.agentDirectory,
    testModel: "local-faux",
  });
  t.after(() => restartedAdapter.closeAll());
  const reopened = await restartedAdapter.openOrCreate({
    ...fixture.input,
    reference: snapshot.reference,
    materialized: true,
  });
  assert.deepEqual(reopened.snapshot().entries, snapshot.entries);
  assert.equal(reopened.snapshot().runState, "idle");
  await restartedAdapter.closeAll();
}

test("a vanished materialized session is reported instead of silently replaced", async (t) => {
  const paths = await makeSandbox();
  const input = makeInput(paths);
  const adapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
  });
  t.after(() => adapter.closeAll());
  t.after(() => removeTree(paths.root));
  await assert.rejects(
    adapter.openOrCreate({
      ...input,
      reference: {
        sessionId: input.activationId,
        sessionFile: join(paths.sessionDirectory, "missing.jsonl"),
      },
      materialized: true,
    }),
    PiSessionUnavailableError,
  );
  assert.equal((await readdir(paths.sessionDirectory)).length, 0);
});

function makeInput(paths) {
  return {
    chatId: asChatId(randomUUID()),
    activationId: asActivationId(randomUUID()),
    workingDirectory: paths.workingDirectory,
    reference: null,
    materialized: false,
  };
}

async function makeSandbox() {
  const root = resolve(await mkdtemp(join(tmpdir(), "aeon-pi-test-")));
  assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}`));
  const paths = {
    root,
    workingDirectory: join(root, "workspace"),
    sessionDirectory: join(root, "pi-sessions"),
    agentDirectory: join(root, "pi-agent-config"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  return paths;
}

/** Windows can hold a temp file open for a moment after a session closes; retry the tidy-up. */
async function removeTree(path) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
