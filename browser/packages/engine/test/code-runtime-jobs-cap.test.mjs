// Settled browser jobs are capped, and what is saved stays well under storage.session's quota.
import assert from "node:assert/strict";
import test from "node:test";

let stored = {};
const warnings = [];
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (value) => {
        if (JSON.stringify(value).length > 10_000_000)
          throw new Error("QUOTA_BYTES quota exceeded");
        stored = { ...stored, ...value };
      },
    },
  },
};
const { jobs, emptyJob, saveJobs, MAX_FINISHED_JOBS, SAVED_JOBS_BUDGET } =
  await import("../dist/code-runtime-jobs.js");

test("30 settled jobs with large results keep only the newest and fit the budget", async () => {
  const big = ["x".repeat(900_000)];
  for (let index = 0; index < 30; index++) {
    const job = emptyJob(`job-${index}`, "chat", 1);
    job.finishedAt = 1_000 + index;
    job.results = big;
    jobs.set(job.run.cellId, job);
  }
  const running = emptyJob("running", "chat", 1);
  running.status = "running";
  running.startedAt = 0;
  jobs.set("running", running);
  await saveJobs();
  assert.ok(jobs.size <= MAX_FINISHED_JOBS + 1, `kept ${jobs.size}`);
  assert.ok(jobs.has("running"));
  assert.ok(jobs.has("job-29") && !jobs.has("job-0"));
  const saved = stored["aeon-code-jobs"];
  assert.equal(saved.length, jobs.size);
  assert.ok(JSON.stringify(saved).length <= SAVED_JOBS_BUDGET + 200_000);
  // The newest keep their results; older ones say why theirs are gone.
  assert.ok(saved.find((item) => item.jobId === "job-29").results);
  assert.match(saved.find((item) => item.jobId === "job-10").error, /too large/);
});

test("a failed write is logged, not swallowed", async () => {
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const set = chrome.storage.session.set;
  chrome.storage.session.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };
  try {
    await saveJobs();
  } finally {
    chrome.storage.session.set = set;
    console.warn = warn;
  }
  assert.ok(warnings.some((line) => /saving job state failed.*QUOTA/.test(line)));
});
