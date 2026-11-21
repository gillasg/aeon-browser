import assert from "node:assert/strict";
import test from "node:test";
import { DROPPED_JOB_REASON, jobIdOf, missingJob } from "../dist/code-job-record.js";

test("a job id is read from the object browser.job.start returned", () => {
  assert.equal(jobIdOf({ id: { jobId: "job-9" } }), "job-9");
  assert.equal(jobIdOf({ id: { id: 4 } }), "4");
  assert.equal(jobIdOf({ jobId: "job-2" }), "job-2");
  assert.equal(jobIdOf({ id: "[object Object]" }), "[object Object]");
});

test("a missing job reports that the worker dropped it, in one line", () => {
  const lost = missingJob("job-9");
  assert.equal(lost.status, "lost");
  assert.equal(lost.state, "lost");
  assert.equal(lost.jobId, "job-9");
  assert.equal(lost.error, DROPPED_JOB_REASON);
  assert.equal(String(lost.error).split("\n").length, 1);
});
