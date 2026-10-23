import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreparedSessionResources } from "../dist/prepared-session-resources.js";

test("prepared resources are consumed once, stay workspace-specific, and invalidate changed settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "aeon-prepared-resources-"));
  const agent = join(root, "agent"),
    first = join(root, "first"),
    second = join(root, "second");
  await mkdir(agent);
  let loads = 0;
  const pool = new PreparedSessionResources(agent, true, async (cwd) => ({ cwd, id: ++loads }));
  try {
    await Promise.all([pool.prepare(first), pool.prepare(first)]);
    assert.equal(loads, 1);
    assert.equal((await pool.take(second)).cwd, second);
    assert.equal((await pool.take(first)).id, 1);
    assert.equal((await pool.take(first)).id, 3);
    await pool.prepare(first);
    await writeFile(join(agent, "settings.json"), '{"defaultTools":["read"]}');
    assert.equal((await pool.take(first)).id, 5);
  } finally {
    pool.clear();
    await rm(root, { recursive: true, force: true });
  }
});
