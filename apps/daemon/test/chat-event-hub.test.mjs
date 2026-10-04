import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { asChatId } from "@pippin/domain";
import { ChatEventHub } from "../dist/chat-event-hub.js";

const chatId = asChatId(randomUUID());
const event = { kind: "run-state", state: "idle" };

test("branch checkpoints retain one replacement rather than many full histories", () => {
  const hub = new ChatEventHub();
  const old = hub.cursor(chatId);
  const replacement = { kind: "view-replaced", entries: [], runState: "idle", contextUsage: null };
  hub.publish(chatId, replacement);
  const previous = hub.cursor(chatId);
  hub.publish(chatId, replacement);
  assert.equal(hub.subscribeFrom(chatId, old, () => {}).kind, "snapshot-required");
  const subscription = hub.subscribeFrom(chatId, previous, () => {});
  assert.equal(subscription.kind, "replay");
  assert.equal(subscription.events.length, 1);
  assert.equal(subscription.events[0].event.kind, "view-replaced");
  subscription.unsubscribe();
});

test("event cursors require snapshots for stale, foreign, and future positions", () => {
  const hub = new ChatEventHub();
  const initial = hub.cursor(chatId);
  for (let revision = 0; revision < 258; revision += 1) hub.publish(chatId, event);

  for (const cursor of [
    initial,
    { epoch: randomUUID(), revision: 200 },
    { epoch: hub.epoch, revision: 259 },
  ]) {
    const subscription = hub.subscribeFrom(chatId, cursor, () => undefined);
    assert.equal(subscription.kind, "snapshot-required");
  }
});

test("event cursors inside the retained range replay only newer events", () => {
  const hub = new ChatEventHub();
  const cursor = hub.cursor(chatId);
  hub.publish(chatId, event);
  const second = hub.publish(chatId, event);
  const subscription = hub.subscribeFrom(chatId, cursor, () => undefined);
  assert.equal(subscription.kind, "replay");
  if (subscription.kind === "replay") {
    assert.deepEqual(
      subscription.events.map(({ cursor: item }) => item.revision),
      [1, 2],
    );
    assert.equal(subscription.cursor.revision, second.cursor.revision);
    subscription.unsubscribe();
  }
});
