// A daemon restart must not leave the extension dead until the user restarts Chrome. The worker's
// plain timers die when MV3 sleeps it; a chrome alarm wakes it to re-bootstrap (new grant, new
// endpoint). This test drives the lifecycle with a controllable fake chrome alarm.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

async function load(directory) {
  const outfile = join(directory, "native-executor-lifecycle.mjs");
  const source = [
    new URL("../src/native-executor-lifecycle.ts", import.meta.url),
    new URL("../node_modules/@browserkit/engine/src/native-executor-lifecycle.ts", import.meta.url),
  ]
    .map((url) => url.pathname.replace(/^\/(\w:)/, "$1"))
    .find((path) => existsSync(path));
  await build({
    entryPoints: [source],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    define: { __GRAFT_NATIVE_TRANSPORT__: "true" },
  });
  return import(pathToFileURL(outfile).href + "?fresh=" + Math.random());
}

function fakeChrome() {
  const alarms = new Map();
  let onAlarm;
  const event = () => ({ addListener() {} });
  return {
    runtime: { onStartup: event(), onInstalled: event() },
    tabs: { onActivated: event() },
    windows: { onFocusChanged: event(), WINDOW_ID_NONE: -1 },
    alarms: {
      create: async (name, info) => alarms.set(name, info),
      clear: async (name) => alarms.delete(name),
      onAlarm: {
        addListener: (listener) => {
          onAlarm = listener;
        },
      },
    },
    alarmsMap: alarms,
    fireAlarm(name) {
      onAlarm?.({ name });
    },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a dropped link retries, arms a wake alarm, and clears it once reconnected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "graft-reconnect-"));
  const previous = globalThis.chrome;
  try {
    globalThis.chrome = fakeChrome();
    const { scheduleExecutorReconnect, noteExecutorConnected } = await load(directory);

    let connects = 0;
    scheduleExecutorReconnect(async () => {
      connects++;
    });
    assert.equal(connects, 0, "the retry waits for the backoff timer");
    assert.equal(globalThis.chrome.alarmsMap.has("graft-executor-reconnect-now"), true);
    const armed = globalThis.chrome.alarmsMap.get("graft-executor-reconnect-now");
    assert.equal(typeof armed.when, "number");
    assert.ok(armed.when >= Date.now() + 29_000, "the wake alarm outlives a sleeping worker");

    await delay(400);
    assert.equal(connects, 1, "the fast timer reconnects while the worker is awake");
    noteExecutorConnected();
    assert.equal(globalThis.chrome.alarmsMap.has("graft-executor-reconnect-now"), false);
  } finally {
    globalThis.chrome = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the alarm installed at startup wakes a sleeping worker and reconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "graft-reconnect-startup-"));
  const previous = globalThis.chrome;
  try {
    globalThis.chrome = fakeChrome();
    const { installNativeStartup, scheduleExecutorReconnect, noteExecutorConnected } =
      await load(directory);
    let connects = 0;
    installNativeStartup(
      async () => {
        connects++;
      },
      () => undefined,
    );
    assert.equal(connects, 1, "worker load warms the connection");
    assert.equal(globalThis.chrome.alarmsMap.has("graft-executor-reconnect"), true);

    scheduleExecutorReconnect(async () => undefined);
    assert.equal(globalThis.chrome.alarmsMap.has("graft-executor-reconnect-now"), true);
    globalThis.chrome.fireAlarm("graft-executor-reconnect-now");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(connects, 2, "Chrome firing the alarm wakes the worker and reconnects");
    noteExecutorConnected();
  } finally {
    globalThis.chrome = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
