import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBench } from "./run.mjs";

test("the bench dry-run checks all three tasks both ways and writes the table", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-bench-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, "results.json");
  const report = await runBench({ dryRun: true, out });
  assert.equal(report.rows.length, 6);
  assert.equal(report.rows.filter((row) => row.way === "scripted").length, 3);
  assert.equal(report.rows.filter((row) => row.way === "agent").length, 3);
  assert.ok(
    report.rows.every((row) => row.pass),
    JSON.stringify(report.rows, null, 2),
  );
  const json = JSON.parse(await readFile(out, "utf8"));
  assert.equal(json.rows.length, 6);
  const table = await readFile(out.replace(/\.json$/, ".md"), "utf8");
  assert.match(table, /\| deals-price \| scripted \| pass \|/);
  assert.match(table, /\| apply-form \| agent \| pass \|/);
});

test("real runs refuse the user's Chrome without --allow-browser", async () => {
  await assert.rejects(() => runBench({ dryRun: false }), /Refusing to drive the user's Chrome/);
});
