import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatReviews } from "../dist/chat-reviews.js";

const parse = (result) => JSON.parse(result.content[0].text);

test("chat reviews: marked chats leave the unreviewed list until they are used again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-reviews-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chats = [
    { chatId: "a", title: "A", updatedAt: "2026-10-15T10:00:00.000Z" },
    { chatId: "b", title: "B", updatedAt: "2026-10-15T09:00:00.000Z" },
  ];
  const reviews = new ChatReviews(root, () => chats);
  assert.deepEqual(
    parse(await reviews.run({ action: "list" })).map((chat) => chat.chatId),
    ["a", "b"],
  );
  await reviews.run({ action: "mark", chatId: "a", note: "click blocked by own dialog" });
  assert.deepEqual(
    parse(await reviews.run({ action: "list" })).map((chat) => chat.chatId),
    ["b"],
  );
  assert.equal(
    await readFile(join(root, "reviews", "a.md"), "utf8"),
    "click blocked by own dialog",
  );
  assert.equal(
    parse(await reviews.run({ action: "get", chatId: "a" })).note,
    "click blocked by own dialog",
  );
  chats[0].updatedAt = "2999-01-01T00:00:00.000Z";
  assert.deepEqual(
    parse(await reviews.run({ action: "list" })).map((chat) => chat.chatId),
    ["a", "b"],
  );
  assert.equal((await reviews.run({ action: "mark", chatId: "zzz" })).isError, true);
});
