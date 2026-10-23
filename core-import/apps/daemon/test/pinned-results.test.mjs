import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PinnedResults, pinValue, pushHistory } from "../dist/pinned-results.js";

test("a value reads as a person would say it", () => {
  assert.equal(pinValue({ price: 2999, title: "Soundcore Q20" }), "Soundcore Q20 · 2999");
  assert.equal(pinValue(["a", "b"]), "2 items: a");
  assert.equal(pinValue("in stock"), "in stock");
  assert.equal(pinValue(true), "true");
  assert.equal(pinValue(null), "");
});

test("history keeps the changes, not every check", () => {
  const first = pushHistory(undefined, "₹2,999", "2026-10-22T10:00:00.000Z");
  const again = pushHistory(first, "₹2,999", "2026-10-22T10:05:00.000Z");
  assert.equal(again.length, 1);
  const dropped = pushHistory(again, "₹2,499", "2026-10-22T10:10:00.000Z");
  assert.deepEqual(
    dropped.map((point) => point.value),
    ["₹2,999", "₹2,499"],
  );
  for (let index = 0; index < 20; index += 1)
    first.push({ at: "2026-10-22T10:00:00.000Z", value: String(index) });
  assert.equal(pushHistory(first, "new", "2026-10-22T11:00:00.000Z").length, 12);
});

test("a saved answer is pinned once, updated by title, and removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-pins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pins = new PinnedResults(root);
  const created = await pins.execute(
    { title: "Cheapest flight", value: "₹4,200", detail: "AI 806 · 6:10 AM" },
    "chat-1",
  );
  assert.equal("pinId" in created && created.value, "₹4,200");
  const again = await pins.execute({ title: "cheapest flight", value: "₹3,900" }, "chat-1");
  assert.equal("pinId" in again && again.pinId, "pinId" in created && created.pinId);
  assert.equal((await pins.list()).length, 1);
  const removed = await pins.execute({ title: "Cheapest flight", remove: true }, "chat-1");
  assert.deepEqual(removed, { removed: true });
  assert.equal((await pins.list()).length, 0);
  assert.ok(JSON.parse(await readFile(join(root, "pinned-results.json"), "utf8")));
});

test("every watcher check updates its pin, passed or not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-pins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pins = new PinnedResults(root);
  const routine = {
    routineId: "11111111-1111-4111-8111-111111111111",
    chatId: "chat-1",
    title: "Watch: Soundcore Q20 price",
    instruction: "Tell me if the price drops under ₹2,500.",
    check: "return {price: 2999}",
    deletedAt: null,
  };
  await pins.recordCheck(routine, { met: false, value: { price: 2999 } });
  await pins.recordCheck(routine, { met: true, value: { price: 2399 } });
  const [pin] = await pins.list();
  assert.equal(pin.title, routine.title);
  assert.equal(pin.value, "2399");
  assert.equal(pin.source, "routine");
  assert.equal(pin.needsYou, true);
  assert.equal(pin.history.length, 2);
  assert.match(pin.condition ?? "", /under ₹2,500/);
});
