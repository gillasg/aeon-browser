import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEventLog } from "@aeon/location";
import { recordRoutineEvent, routineEventKind } from "../dist/routine-events.js";

test("a fired routine is logged with a monotonic cursor and scrubbed before disk", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aeon-routine-events-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const routine = { routineId: "r1", title: "Price", sites: ["shop.test"], check: "price" };
  const first = await recordRoutineEvent(dir, routine, { price: 9, otp: "551234" });
  const second = await recordRoutineEvent(
    dir,
    { ...routine, webhook: { url: "https://hook.test" } },
    "your code is 482913",
  );
  assert.equal(first.cursor, 1);
  assert.equal(second.cursor, 2);
  assert.equal(first.kind, "watcher");
  assert.equal(second.kind, "webhook");
  const raw = JSON.stringify(await readEventLog(dir));
  assert.ok(!raw.includes("551234") && !raw.includes("482913"), raw);
  assert.equal(routineEventKind(routine), "watcher");
});
