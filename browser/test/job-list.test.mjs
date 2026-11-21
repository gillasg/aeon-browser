import assert from "node:assert/strict";
import test from "node:test";
import {
  ambiguousBrowser,
  browserNames,
  mergeJobLists,
  preferJob,
} from "../apps/bridge/dist/job-list.js";

test("an ambiguous browser error is recognised, and names come from the browser list", () => {
  assert.equal(ambiguousBrowser(new Error("Several browsers are connected. Pick one.")), true);
  assert.equal(ambiguousBrowser(new Error("AMBIGUOUS_BROWSER")), true);
  assert.equal(ambiguousBrowser(new Error("BROWSER_OFFLINE")), false);
  assert.deepEqual(
    browserNames({
      browsers: [{ name: "recording", clientInstanceId: "a" }, { clientInstanceId: "b" }],
    }),
    ["recording", "b"],
  );
});

test("jobs from every browser merge, and a live job beats a lost one", () => {
  const lost = { jobId: "j", status: "lost", error: "dropped", done: 0, total: 3 };
  const running = { jobId: "j", status: "running", done: 2, total: 3 };
  assert.equal(preferJob([lost, running]).status, "running");
  assert.deepEqual(mergeJobLists([[lost, { jobId: "other", status: "complete" }], [running]]), [
    running,
    { jobId: "other", status: "complete" },
  ]);
});
