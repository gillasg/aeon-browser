import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createLocalFixtureRuntime } from "../dist/dev-runtime.js";
import { startDevHandshakeServer } from "../dist/dev-harness.js";
import { connectDevUi, requestId } from "./dev-chat-client.mjs";

const DEV_GRANT = "A".repeat(43);

test("UI Chat streams Pi events, closes one view, and reopens the Pi snapshot", async (t) => {
  const context = await createEnvironment(t);
  const { chatId, firstSnapshot, secondSnapshot } = await createChatAndSubscribe(context);
  const { submitId, closeHistoryLength } = await closeFirstViewDuringRun(
    context,
    chatId,
    firstSnapshot,
    secondSnapshot,
  );
  const persisted = await verifyCompletedSnapshot(
    context,
    chatId,
    submitId,
    closeHistoryLength,
    firstSnapshot,
    secondSnapshot,
  );
  await restartAndVerify(context, chatId, persisted);
});

async function createEnvironment(t) {
  const dataDirectory = resolve(await mkdtemp(join(tmpdir(), "aeon-dev-chat-")));
  assert.ok(dataDirectory.startsWith(`${resolve(tmpdir())}${sep}`));
  const context = {
    dataDirectory,
    runtime: createLocalFixtureRuntime(dataDirectory),
    daemon: undefined,
    firstView: undefined,
    secondView: undefined,
    reopened: undefined,
  };
  t.after(() => cleanup(context));
  context.daemon = await startServer(context.runtime);
  context.firstView = await connectDevUi(context.daemon.url, DEV_GRANT);
  context.secondView = await connectDevUi(context.daemon.url, DEV_GRANT);
  return context;
}

async function startServer(runtime) {
  return startDevHandshakeServer({
    chatService: runtime.service,
    port: 0,
    grant: DEV_GRANT,
    printGrant: false,
  });
}

async function cleanup(context) {
  await context.firstView?.close();
  await context.secondView?.close();
  await context.reopened?.close();
  try {
    await context.daemon?.close();
  } finally {
    await context.runtime?.close();
    await rm(context.dataDirectory, { recursive: true, force: true });
  }
}

async function createChatAndSubscribe(context) {
  const createRequestId = requestId();
  context.firstView.send({
    kind: "command",
    requestId: createRequestId,
    operation: "chat.create",
    payload: { title: "Local fixture lifecycle" },
  });
  const created = await context.firstView.waitFor(
    (message) => message.kind === "command.completed" && message.requestId === createRequestId,
  );
  const chatId = created.result.chat.chatId;
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    subscribe(context.firstView, chatId),
    subscribe(context.secondView, chatId),
  ]);
  return { chatId, firstSnapshot, secondSnapshot };
}

async function subscribe(view, chatId) {
  const reqId = requestId();
  view.send({ kind: "chat.subscribe", requestId: reqId, chatId });
  return view.waitFor((message) => message.kind === "chat.snapshot" && message.requestId === reqId);
}

async function closeFirstViewDuringRun(context, chatId, firstSnapshot, secondSnapshot) {
  const submitId = requestId();
  context.firstView.send({
    kind: "command",
    requestId: submitId,
    operation: "chat.submit",
    payload: { chatId, text: "List this local workspace, then summarize it." },
  });
  const started = await context.firstView.waitFor(
    (message) => message.kind === "command.started" && message.requestId === submitId,
  );
  assert.equal(started.piAcceptance, "unknown");
  const update = await context.secondView.waitFor((message) =>
    isAssistantUpdate(message, secondSnapshot),
  );
  assert.equal(update.chatId, chatId);
  const closeHistoryLength = await closeView(
    context.firstView,
    chatId,
    firstSnapshot.subscriptionId,
  );
  return { submitId, closeHistoryLength };
}

function isAssistantUpdate(message, snapshot) {
  return (
    message.kind === "chat.event" &&
    message.subscriptionId === snapshot.subscriptionId &&
    message.event.event.kind === "message-update" &&
    message.event.event.message.role === "assistant" &&
    message.event.event.message.content.some(
      (block) => block.type === "text" && block.text.length > 0,
    )
  );
}

async function closeView(view, chatId, subscriptionId) {
  const reqId = requestId();
  view.send({ kind: "chat.close-view", requestId: reqId, chatId, subscriptionId });
  await view.waitFor(
    (message) => message.kind === "chat.view-closed" && message.requestId === reqId,
  );
  return view.history.length;
}

async function verifyCompletedSnapshot(
  context,
  chatId,
  submitId,
  closeHistoryLength,
  firstSnapshot,
  secondSnapshot,
) {
  const settled = await context.firstView.waitFor(
    (message) => message.kind === "command.settled" && message.requestId === submitId,
    15000,
  );
  assert.equal(settled.state, "settled");
  assert.equal(settled.runState, "idle");
  const eventsAfterClose = context.firstView.history
    .slice(closeHistoryLength)
    .filter(
      (message) =>
        message.kind === "chat.event" && message.subscriptionId === firstSnapshot.subscriptionId,
    );
  assert.deepEqual(eventsAfterClose, []);
  verifyToolTrace(context.secondView.history, secondSnapshot);

  const beforeRestart = await getChatView(context.firstView, chatId);
  const persisted = beforeRestart.result.snapshot;
  const ids = persisted.entries.map(({ entryId }) => entryId);
  assert.ok(persisted.entries.some(({ message }) => message?.role === "user"));
  assert.ok(persisted.entries.some(({ message }) => message?.role === "assistant"));
  assert.ok(persisted.entries.some(({ message }) => message?.role === "tool"));
  assert.ok(
    persisted.entries
      .filter(({ message }) => message?.role === "custom")
      .every(({ message }) => message.content.length === 0),
  );
  assert.equal(new Set(ids).size, ids.length);
  verifyEventRevisions(context.secondView.history, secondSnapshot);
  assert.deepEqual(firstSnapshot.snapshot.entries, []);
  await assertCatalogSearch(context.firstView, chatId);
  await assertMetadataUpdate(context.secondView, chatId, secondSnapshot.subscriptionId);
  return { beforeRestart, persisted };
}

async function assertCatalogSearch(view, expectedChatId) {
  const reqId = requestId();
  view.send({
    kind: "command",
    requestId: reqId,
    operation: "chat.list",
    payload: { limit: 20, query: "local fixture response" },
  });
  const response = await view.waitFor(
    (message) => message.kind === "command.completed" && message.requestId === reqId,
  );
  assert.equal(response.result.kind, "chat.listed");
  const match = response.result.chats.find(({ chatId }) => chatId === expectedChatId);
  assert.match(match?.matchExcerpt ?? "", /Local fixture response/);
}

async function assertMetadataUpdate(view, chatId, subscriptionId) {
  const reqId = requestId();
  view.send({
    kind: "command",
    requestId: reqId,
    operation: "chat.update",
    payload: { chatId, pinned: true },
  });
  const response = await view.waitFor(
    (message) => message.kind === "command.completed" && message.requestId === reqId,
  );
  assert.equal(response.result.kind, "chat.updated");
  assert.equal(response.result.chat.pinned, true);
  const event = await view.waitFor(
    (message) =>
      message.kind === "chat.event" &&
      message.subscriptionId === subscriptionId &&
      message.event.event.kind === "chat-metadata",
  );
  assert.equal(event.event.event.pinned, true);
}

function verifyToolTrace(history, snapshot) {
  const events = history
    .filter(
      (message) =>
        message.kind === "chat.event" && message.subscriptionId === snapshot.subscriptionId,
    )
    .map(({ event }) => event.event);
  const toolStarted = events.find(({ kind }) => kind === "tool-start");
  const toolEnded = events.find(({ kind }) => kind === "tool-end");
  assert.ok(toolStarted);
  assert.ok(toolEnded);
  assert.equal(toolStarted.toolCallId, toolEnded.toolCallId);
}

function verifyEventRevisions(history, snapshot) {
  const revisions = history
    .filter(
      (message) =>
        message.kind === "chat.event" && message.subscriptionId === snapshot.subscriptionId,
    )
    .map(({ event }) => event.cursor.revision);
  assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]));
}

async function getChatView(view, chatId) {
  const reqId = requestId();
  view.send({
    kind: "command",
    requestId: reqId,
    operation: "chat.get",
    payload: { chatId },
  });
  return view.waitFor(
    (message) => message.kind === "command.completed" && message.requestId === reqId,
  );
}

async function restartAndVerify(context, chatId, { beforeRestart, persisted }) {
  await context.firstView.close();
  await context.secondView.close();
  await context.daemon.close();
  await context.runtime.close();
  context.runtime = createLocalFixtureRuntime(context.dataDirectory);
  context.daemon = await startServer(context.runtime);
  context.reopened = await connectDevUi(context.daemon.url, DEV_GRANT);
  const subscribeId = requestId();
  context.reopened.send({
    kind: "chat.subscribe",
    requestId: subscribeId,
    chatId,
    afterCursor: beforeRestart.result.cursor,
  });
  const snapshot = await context.reopened.waitFor(
    (message) => message.kind === "chat.snapshot" && message.requestId === subscribeId,
  );
  assert.notEqual(snapshot.cursor.epoch, beforeRestart.result.cursor.epoch);
  assert.equal(snapshot.snapshot.runState, "idle");
  assert.deepEqual(snapshot.snapshot.entries, persisted.entries);
  assert.deepEqual(
    snapshot.snapshot.entries.map(({ entryId }) => entryId),
    persisted.entries.map(({ entryId }) => entryId),
  );
  const reopenedView = await getChatView(context.reopened, chatId);
  assert.deepEqual(reopenedView.result.snapshot.entries, persisted.entries);
}
