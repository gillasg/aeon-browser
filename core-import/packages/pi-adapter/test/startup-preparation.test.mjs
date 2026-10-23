import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers";
import { BackgroundCache } from "../dist/background-cache.js";
import { PreparedModelRuntime } from "../dist/prepared-model-runtime.js";

test("expired catalog serves its successful value during one background refresh", async () => {
  let loads = 0,
    finish;
  const cache = new BackgroundCache(
    () =>
      ++loads === 1
        ? Promise.resolve("first")
        : new Promise((resolve) => {
            finish = resolve;
          }),
    0,
  );
  assert.equal(await cache.read(), "first");
  assert.equal(await cache.read(), "first");
  assert.equal(await cache.read(), "first");
  assert.equal(loads, 2);
  finish("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.read(), "second");
});
test("failed refresh retains the usable catalog and cold initialization can retry", async () => {
  let loads = 0;
  const cache = new BackgroundCache(async () => {
    if (++loads === 1) throw new Error("unavailable");
    if (loads === 2) return "ready";
    throw new Error("refresh failed");
  }, 0);
  await assert.rejects(cache.read(), /unavailable/);
  assert.equal(await cache.read(), "ready");
  assert.equal(await cache.read(), "ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.read(), "ready");
});
test("prepared runtime is ready before consumption and belongs to only one session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-prepared-model-"));
  let creations = 0;
  const pool = new PreparedModelRuntime(directory, async (options) => ({
    id: ++creations,
    options,
  }));
  try {
    pool.prepare();
    pool.prepare();
    assert.equal(creations, 1);
    const [first, second] = await Promise.all([pool.take(), pool.take()]);
    assert.notEqual(first.id, second.id);
    assert.equal(first.id, 1);
    assert.equal(first.options.authPath, join(directory, "auth.json"));
    await writeFile(join(directory, "auth.json"), "{}");
    pool.prepare();
    assert.equal((await pool.take()).id, 4);
  } finally {
    pool.close();
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(pool.take(), /closed/);
});
