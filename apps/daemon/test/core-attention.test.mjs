import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreAttention } from "../dist/core-attention.js";

test("completion is shared, claimed once, read by completion identity, and persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-attention-test-"));
  let publish;
  const service = {
    getChat: () => ({}),
    subscribeAllEvents: (listener) => {
      publish = listener;
      return () => {};
    },
  };
  const chatId = randomUUID(),
    attention = new CoreAttention(directory, service);
  try {
    publish(chatId, { kind: "run-state", state: "running-unconfirmed" });
    assert.equal(attention.snapshot().chats[0].working, true);
    publish(chatId, { kind: "run-state", state: "idle" });
    const completionId = attention.snapshot().chats[0].completionId;
    const request = { kind: "core.attention.claim", chatId, completionId };
    assert.equal(attention.handle({}, request).granted, true);
    assert.equal(attention.handle({}, request).granted, false);
    attention.handle(
      {},
      {
        kind: "core.attention.read",
        chatId,
        completionId: randomUUID(),
        viewId: randomUUID(),
        visible: true,
      },
    );
    assert.equal(attention.snapshot().chats[0].unread, true);
    await attention.close();
    const recovered = new CoreAttention(directory, service);
    assert.equal(recovered.snapshot().chats[0].unread, true);
    recovered.handle(
      {},
      { kind: "core.attention.read", chatId, completionId, viewId: randomUUID(), visible: true },
    );
    assert.equal(recovered.snapshot().chats[0].unread, false);
    await recovered.close();
  } finally {
    await attention.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid completion metadata cannot prevent Core startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-attention-corrupt-"));
  try {
    await writeFile(join(directory, "core-attention.json"), "{broken");
    const attention = new CoreAttention(directory, {
      getChat: () => ({}),
      subscribeAllEvents: () => () => {},
    });
    assert.deepEqual(attention.snapshot().chats, []);
    await attention.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("attention stays bounded: old records are dropped and a refused claim is never re-decided", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-attention-bounded-"));
  let publish;
  let lookups = 0;
  const service = {
    getChat: () => {
      lookups += 1;
      return { origin: "cli" };
    },
    subscribeAllEvents: (listener) => {
      publish = listener;
      return () => {};
    },
  };
  const attention = new CoreAttention(directory, service);
  try {
    for (let index = 0; index < 260; index += 1) {
      const chatId = randomUUID();
      publish(chatId, { kind: "run-state", state: "running-unconfirmed" });
      publish(chatId, { kind: "run-state", state: "idle" });
    }
    const chats = attention.snapshot().chats;
    assert.ok(chats.length <= 200, `records: ${chats.length}`);
    const { chatId, completionId } = chats.at(-1);
    const request = { kind: "core.attention.claim", chatId, completionId };
    assert.equal(attention.handle({}, request).granted, false);
    lookups = 0;
    assert.equal(attention.handle({}, request).granted, false);
    assert.ok(lookups <= 1, "a decided claim does not re-check the chat's origin");
  } finally {
    await attention.close();
    await rm(directory, { recursive: true, force: true });
  }
});
