import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteChangeSetsStore } from "../dist/index.js";

test("browser.changes sets outlive the store being closed and opened again", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "graft-change-sets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new SqliteChangeSetsStore(directory);
  assert.equal(store.put("routine:r1", "lamps", [["1", { id: 1, price: 10 }]]), true);
  store.put("chat:c1", "lamps", [["9", { id: 9 }]]);
  store.close();
  store = new SqliteChangeSetsStore(directory);
  assert.deepEqual(store.get("routine:r1", "lamps"), [["1", { id: 1, price: 10 }]]);
  assert.deepEqual(store.get("chat:c1", "lamps"), [["9", { id: 9 }]]);
  assert.equal(store.get("routine:r2", "lamps"), undefined);
  store.deleteOwner("routine:r1");
  assert.equal(store.get("routine:r1", "lamps"), undefined);
  store.close();
});
