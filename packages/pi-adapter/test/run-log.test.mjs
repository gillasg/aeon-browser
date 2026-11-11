import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finishRunLog, runLogName, startRunLog, tallyCell, writeRunLog } from "../dist/run-log.js";
import {
  closeBrowserSessionLifecycle,
  installBrowserSessionLifecycle,
} from "../dist/browser-session-lifecycle.js";

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
    listener({ type: "agent_end" });
    await closeBrowserSessionLifecycle(session);
    const [file] = (await readdir(join(workspace, "runs"))).filter((name) =>
      name.endsWith(".json"),
    );
    const log = JSON.parse(await readFile(join(workspace, "runs", file), "utf8"));
    assert.match(file, /\.json$/);
    assert.deepEqual(log.hosts, ["other.example", "shop.example"]);
    assert.ok(log.endedAt);
  } finally {
    await closeBrowserSessionLifecycle(session);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("closing the session while a run-log write is pending writes nothing afterwards", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "aeon-runlog-close-"));
  let releaseHold = () => undefined;
  const holdRunLog = new Promise((done) => {
    releaseHold = () => {
      releaseHold = () => undefined;
      done();
    };
  });
  let deliver = () => undefined;
  const session = {
    subscribe(fn) {
      deliver = fn;
      return () => undefined;
    },
  };
  installBrowserSessionLifecycle(session, "chat-close", undefined, { workspace, holdRunLog });
  try {
    deliver({ type: "agent_start" });
    deliver({ type: "agent_end" });
    await wait(20);
    assert.deepEqual(await runFiles(workspace), []);

    let settled = false;
    const closing = closeBrowserSessionLifecycle(session).then(() => {
      settled = true;
    });
    await wait(30);
    assert.equal(settled, false, "close waits while the run-log write is still pending");
    assert.deepEqual(await runFiles(workspace), []);

    releaseHold();
    await closing;
    const atClose = await runFiles(workspace);
    assert.equal(atClose.filter((name) => name.endsWith(".json")).length, 1);

    deliver({ type: "agent_start" });
    deliver({ type: "agent_end" });
    await wait(40);
    assert.deepEqual(await runFiles(workspace), atClose);
  } finally {
    releaseHold();
    await closeBrowserSessionLifecycle(session);
    await rm(workspace, { recursive: true, force: true });
  }
});

async function runFiles(workspace) {
  const names = await readdir(join(workspace, "runs")).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return names.sort();
}
