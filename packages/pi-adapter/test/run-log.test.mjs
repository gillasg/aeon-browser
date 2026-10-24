import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finishRunLog, runLogName, startRunLog, tallyCell, writeRunLog } from "../dist/run-log.js";
import { installBrowserSessionLifecycle } from "../dist/browser-session-lifecycle.js";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The steps one browser_code cell reports: an open and a navigation. */
function steps() {
  return [
    { action: { op: "openTab", url: "https://shop.example/x" }, result: { kind: "tab" } },
    { action: { op: "navigate", url: "https://other.example/y" }, result: {} },
    { action: { op: "read" }, result: { tab: { url: "https://shop.example/x" } } },
  ];
}

test("a run log collects tabs, hosts, files and jobs, and the run's end closes it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "aeon-runlog-"));
  try {
    startRunLog("chat-one", 1_700_000_000_000);
    const name = tallyCell("chat-one", {
      tabStats: { opened: 2, closed: 1, mine: [11, 12] },
      opened: [{ tabId: 12 }],
      steps: steps(),
      files: ["deals.csv"],
      value: { jobId: "0b9d1f7e-1111-4222-8333-944455556666" },
    });
    assert.equal(name, runLogName(1_700_000_000_000));
    await writeRunLog("chat-one", workspace);

    const mid = JSON.parse(await readFile(join(workspace, name), "utf8"));
    assert.equal(mid.tabs.opened, 2);
    assert.equal(mid.tabs.closed, 1);
    assert.deepEqual(mid.tabs.ids, [11, 12]);
    assert.deepEqual(mid.hosts, ["other.example", "shop.example"]);
    assert.deepEqual(mid.files, ["deals.csv"]);
    assert.deepEqual(mid.jobs, ["0b9d1f7e-1111-4222-8333-944455556666"]);
    assert.equal(mid.endedAt, undefined);

    await finishRunLog("chat-one", workspace);
    const final = JSON.parse(await readFile(join(workspace, name), "utf8"));
    assert.ok(final.endedAt, "the final log says when the run ended");
    // The run is over: another cell does not reopen its log.
    assert.equal(await writeRunLog("chat-one", workspace), undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a whole run writes runs/<time>.json through the session lifecycle", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "aeon-runlog-life-"));
  let listener;
  const session = {
    subscribe(fn) {
      listener = fn;
      return () => undefined;
    },
  };
  try {
    installBrowserSessionLifecycle(session, "chat-two", undefined, { workspace });
    listener({ type: "agent_start" });
    tallyCell("chat-two", { steps: steps(), files: [] });
    await writeRunLog("chat-two", workspace);
    listener({ type: "agent_end" });
    await wait(50);
    const [file] = await readdir(join(workspace, "runs"));
    assert.match(file, /\.json$/);
    const log = JSON.parse(await readFile(join(workspace, "runs", file), "utf8"));
    assert.deepEqual(log.hosts, ["other.example", "shop.example"]);
    assert.ok(log.endedAt);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
