import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as root from "./test-shard.mjs";
import * as browser from "../browser/scripts/test-shard.mjs";

const files = ["d.test.mjs", "a.test.mjs", "c.test.mjs", "e.test.mjs", "b.test.mjs"];

for (const [name, mod] of [
  ["root", root],
  ["browser", browser],
]) {
  test(`${name}: shards partition the sorted file list`, () => {
    for (const total of [1, 2, 3, 4, 7]) {
      const shards = Array.from({ length: total }, (_, i) =>
        mod.selectShard(files, mod.parseShard([`--shard=${i + 1}/${total}`])),
      );
      assert.deepEqual(shards.flat().sort(), [...files].sort());
      assert.equal(new Set(shards.flat()).size, files.length);
      assert.deepEqual(
        shards,
        Array.from({ length: total }, (_, i) =>
          mod.selectShard([...files].reverse(), { index: i + 1, total }),
        ),
      );
    }
  });

  test(`${name}: no --shard keeps every file`, () => {
    assert.equal(mod.parseShard(["--browser", "x"]), null);
    assert.deepEqual(mod.selectShard(files, null), [...files].sort());
  });

  test(`${name}: invalid shards are rejected`, () => {
    for (const bad of [
      "--shard=0/3",
      "--shard=4/3",
      "--shard=1/0",
      "--shard=a/b",
      "--shard=1",
      "--shard",
    ]) {
      assert.throws(() => mod.parseShard([bad]), /invalid --shard/);
    }
  });
}

test("run-tests exits non-zero on an invalid shard", () => {
  for (const script of ["scripts/run-tests.mjs", "browser/scripts/run-tests.mjs"]) {
    const run = spawnSync(process.execPath, [script, "--shard=5/3", "none/*.test.mjs"], {
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /invalid --shard=5\/3/);
  }
});
