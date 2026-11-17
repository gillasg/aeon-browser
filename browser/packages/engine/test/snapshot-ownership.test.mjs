// One chat's snapshots must not retire another chat's refs on a tab the debugger shares.
import assert from "node:assert/strict";
import test from "node:test";

const target = {
  clientInstanceId: "client-1",
  browserRunId: "run-1",
  tabId: 7,
  tabIncarnation: "inc-1",
};
const chatA = "11111111-1111-4111-8111-111111111111";
const chatB = "22222222-2222-4222-8222-222222222222";

globalThis.chrome = {
  debugger: {
    sendCommand: async (_debuggee, method) => (method === "DOM.describeNode" ? { node: {} } : {}),
    onEvent: { addListener() {}, removeListener() {} },
  },
};

const { snapshotKey } = await import("../dist/native-browser-common.js");
const { browserObservationRefs } = await import("../dist/native-browser-observation.js");
const { resolveElement } = await import("../dist/native-browser-debugger.js");

test("the snapshot key is namespaced by chat", () => {
  assert.notEqual(snapshotKey(chatA, target), snapshotKey(chatB, target));
  assert.equal(
    snapshotKey(undefined, target),
    `${target.clientInstanceId}/${target.browserRunId}/${target.tabId}/${target.tabIncarnation}`,
  );
});

test("a second chat reading the same tab cannot retire the first chat's refs", async () => {
  const { refs, latestSnapshots } = browserObservationRefs;
  const snapA = "snap-a";
  const snapB = "snap-b";
  refs.set(
    snapA,
    new Map([["e1", { backendNodeId: 5, role: "button", name: "Go", documentEpoch: 1 }]]),
  );
  refs.set(
    snapB,
    new Map([["e1", { backendNodeId: 6, role: "link", name: "Next", documentEpoch: 1 }]]),
  );
  latestSnapshots.set(snapshotKey(chatA, target), snapA);
  latestSnapshots.set(snapshotKey(chatB, target), snapB);

  const elementA = { kind: "ref", snapshotId: snapA, ref: "e1" };
  // Chat A's ref still resolves after chat B took its own snapshot of this tab.
  const resolved = await resolveElement(
    { tabId: target.tabId },
    elementA,
    target,
    refs,
    latestSnapshots,
    1,
    chatA,
  );
  assert.equal(resolved.backendNodeId, 5);

  // Chat A's ref cannot be spent in chat B's session, nor the other way round.
  await assert.rejects(
    resolveElement({ tabId: target.tabId }, elementA, target, refs, latestSnapshots, 1, chatB),
    /STALE_REF/,
  );
  await assert.rejects(
    resolveElement(
      { tabId: target.tabId },
      { kind: "ref", snapshotId: snapB, ref: "e1" },
      target,
      refs,
      latestSnapshots,
      1,
      chatA,
    ),
    /STALE_REF/,
  );
});
