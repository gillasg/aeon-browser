// The kernel bench's own pieces, offline: its cells are valid browser code, results summarise and
// a regression is flagged only past both the relative and the absolute margin.
import assert from "node:assert/strict";
import test from "node:test";
import { jobs, lastValue, regressions, summarise } from "./kernel/run.mjs";

test("every kernel job is valid browser code with an expected value", () => {
  const list = jobs("http://127.0.0.1:1");
  assert.equal(new Set(list.map((job) => job.id)).size, list.length);
  for (const job of list) {
    new Function(`return async () => { let page; ${job.code} }`);
    assert.notEqual(job.expect, undefined, job.id);
  }
});

test("a run counts only cells that printed the expected value", () => {
  const runs = [
    { ms: 300, status: 0, out: "[ok] navigate\nPage A" },
    { ms: 500, status: 0, out: "Page B" },
    { ms: 400, status: 1, out: "TAB_DEAD" },
  ];
  assert.deepEqual(summarise("open-title", runs, "Page A"), {
    id: "open-title",
    medianMs: 400,
    ok: 1,
    reps: 3,
    chars: 20,
  });
  assert.equal(lastValue("noise\ntrue"), true);
});

test("regressions need both margins: small jitter is not flagged", () => {
  const baseline = [{ id: "a", medianMs: 1000, ok: 3, reps: 3, chars: 1000 }];
  assert.deepEqual(
    regressions([{ id: "a", medianMs: 1100, ok: 3, reps: 3, chars: 1100 }], baseline),
    [],
  );
  const flagged = regressions([{ id: "a", medianMs: 1400, ok: 2, reps: 3, chars: 1600 }], baseline);
  assert.equal(flagged.length, 3, flagged.join("\n"));
});
