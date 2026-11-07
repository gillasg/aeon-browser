// The chaos suite's own pieces, offline: its cells parse, results parse, and the verdict fails on
// a leak, a slow timeout or a daemon that never came back. The suite itself runs by hand.
import assert from "node:assert/strict";
import test from "node:test";
import { hangCode, judge, parseResult, tabCountCode, visitCode } from "./chaos/run.mjs";

test("every chaos cell is valid browser code", () => {
  for (const code of [tabCountCode, visitCode("http://127.0.0.1:1/", 0), hangCode])
    new Function(`return async () => { let page; ${code} }`);
  assert.match(visitCode("http://127.0.0.1:1/", 3), /\?s=3/);
});

test("a RESULT line parses, and a failure keeps its last words", () => {
  assert.deepEqual(parseResult('noise\nRESULT {"title":"chaos"}\n'), { value: { title: "chaos" } });
  assert.match(parseResult("boom\nTAB_UNRESPONSIVE: the tab").error, /TAB_UNRESPONSIVE/);
});

test("the verdict fails on a leak, a slow timeout and a lost daemon", () => {
  const good = judge({
    concurrent: { runs: [{ value: { title: "chaos" } }], wallMs: 900 },
    leak: { before: 4, after: 4 },
    timeout: { hang: { status: 1, ms: 9000 }, next: { value: {} }, limitSeconds: 8 },
    daemon: { recoveredMs: 20000, boundMs: 90000 },
  });
  assert.equal(good.ok, true, good.lines.join("\n"));
  assert.equal(judge({ leak: { before: 4, after: 5 } }).ok, false);
  assert.equal(
    judge({ timeout: { hang: { status: 1, ms: 60000 }, next: { value: {} }, limitSeconds: 8 } }).ok,
    false,
  );
  assert.equal(judge({ daemon: { recoveredMs: null, boundMs: 90000 } }).ok, false);
});
