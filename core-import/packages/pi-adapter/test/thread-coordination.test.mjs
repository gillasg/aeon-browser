import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { asActivationId, asChatId } from "@aeon/domain";
import { PiSdkSessionAdapter } from "../dist/index.js";

test("Pi creates an exact detached fork without changing the source branch", async (t) => {
  const { paths, adapter, sourceReference, source, userEntryId, selectedEntryId } =
    await prepareThreadCoordinationCase1Stage1(t);
  const { forkReference, evidence } = await verifyThreadCoordinationCase1Stage2(
    paths,
    adapter,
    sourceReference,
    source,
    userEntryId,
    selectedEntryId,
  );
  await verifyThreadCoordinationCase1Stage3(
    sourceReference,
    selectedEntryId,
    forkReference,
    evidence,
  );
});

async function assertUnsupportedUserFork(
  adapter,
  sourceReference,
  workingDirectory,
  entryId,
  source,
  sourceLeafBefore,
) {
  const targetChatId = asChatId(randomUUID());
  await assert.rejects(
    adapter.forkFromEntry({ reference: sourceReference, workingDirectory, entryId, targetChatId }),
    /branch has no assistant message/,
  );
  assert.equal(source.getLeafId(), sourceLeafBefore);
  assert.equal(
    adapter.findDetachedFork({ sourceReference, workingDirectory, entryId, targetChatId }).kind,
    "none",
  );
}

test("thread delivery uses Pi custom entries and exact turn settlement receipts", async (t) => {
  const paths = await makeSandbox();
  const adapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
    testModel: "local-faux",
  });
  t.after(() => adapter.closeAll());
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const recipientChatId = asChatId(randomUUID());
  const session = await adapter.openOrCreate({
    chatId: recipientChatId,
    activationId: asActivationId(randomUUID()),
    workingDirectory: paths.workingDirectory,
    reference: null,
    materialized: false,
  });
  const deliveryId = randomUUID();
  const events = [];
  const unsubscribe = session.subscribeThreadDelivery((event) => events.push(event));
  t.after(unsubscribe);

  const acceptance = await session.deliverThreadMessage({
    deliveryId,
    senderChatId: asChatId(randomUUID()),
    recipientChatId,
    senderTitle: "Planner",
    senderToolCallId: "tool-call-causal-1",
    message: "Inspect the latest build result.",
    inReplyTo: null,
    mode: "followUp",
  });
  assert.equal(acceptance.state, "accepted");
  assert.ok(acceptance.piEntryId);

  await waitFor(() =>
    events.some((event) => event.deliveryId === deliveryId && event.phase === "completed"),
  );
  const evidence = session.findThreadDelivery(deliveryId);
  assert.equal(evidence.state, "completed");
  assert.equal(evidence.piEntryId, acceptance.piEntryId);
  assert.ok(evidence.acceptedTurnId);
  const entry = session.snapshot().entries.find(({ entryId }) => entryId === acceptance.piEntryId);
  assert.equal(entry.message.content[0].type, "thread-message");
  assert.equal(entry.message.content[0].message, "Inspect the latest build result.");
});

async function makeSandbox() {
  const root = resolve(await mkdtemp(join(tmpdir(), "aeon-thread-pi-test-")));
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

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for an exact Pi delivery event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function prepareThreadCoordinationCase1Stage1(t) {
  const paths = await makeSandbox();
  const adapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
    testModel: "local-faux",
  });
  t.after(() => adapter.closeAll());
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const sourceSession = await adapter.openOrCreate({
    chatId: asChatId(randomUUID()),
    activationId: asActivationId(randomUUID()),
    workingDirectory: paths.workingDirectory,
    reference: null,
    materialized: false,
  });
  await sourceSession.submit("Keep this persisted Pi transcript available for a fork.");
  const sourceReference = sourceSession.reference;
  const source = SessionManager.open(sourceReference.sessionFile);
  const sourceBranch = source.getBranch();
  const userEntryId = sourceBranch.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  )?.id;
  const selectedEntryId = sourceBranch.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  )?.id;
  assert.ok(userEntryId);
  assert.ok(selectedEntryId);
  return { paths, adapter, sourceReference, source, userEntryId, selectedEntryId };
}

async function verifyThreadCoordinationCase1Stage2(
  paths,
  adapter,
  sourceReference,
  source,
  userEntryId,
  selectedEntryId,
) {
  assert.deepEqual(
    adapter.inspectForkEntry({
      reference: sourceReference,
      workingDirectory: paths.workingDirectory,
      entryId: userEntryId,
    }),
    { supported: false, reason: "branch_without_assistant" },
  );
  const sourceLeafBefore = source.getLeafId();
  await assertUnsupportedUserFork(
    adapter,
    sourceReference,
    paths.workingDirectory,
    userEntryId,
    source,
    sourceLeafBefore,
  );
  const targetChatId = asChatId(randomUUID());
  const forkReference = await adapter.forkFromEntry({
    reference: sourceReference,
    workingDirectory: paths.workingDirectory,
    entryId: selectedEntryId,
    targetChatId,
  });
  assert.notEqual(forkReference.sessionId, sourceReference.sessionId);
  assert.equal(source.getLeafId(), sourceLeafBefore);
  const evidence = adapter.findDetachedFork({
    sourceReference,
    workingDirectory: paths.workingDirectory,
    entryId: selectedEntryId,
    targetChatId,
  });
  return { forkReference, evidence };
}

async function verifyThreadCoordinationCase1Stage3(
  sourceReference,
  selectedEntryId,
  forkReference,
  evidence,
) {
  assert.equal(evidence.kind, "found");
  assert.deepEqual(evidence.reference, forkReference);
  const fork = SessionManager.open(forkReference.sessionFile);
  assert.equal(fork.getLeafId(), selectedEntryId);
  assert.equal(fork.getHeader()?.parentSession, sourceReference.sessionFile);
}
