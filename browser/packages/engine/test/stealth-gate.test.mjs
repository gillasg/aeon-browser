// The stealth conformance gate: zero Graft-specific page tells and zero CDP tells at rest, an honest
// tap ledger, and no web-accessible resource an extension-ID probe could find.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sent = [];
const scripted = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (target, method, params) => {
      sent.push({ tabId: target.tabId, method, params });
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      return {};
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  scripting: {
    executeScript: async (options) => {
      scripted.push(options);
      return [{ result: true }];
    },
  },
  tabs: { onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
  storage: {},
};

const realtime = await import("../dist/native-browser-realtime.js");
const events = await import("../dist/native-browser-events.js");
const stealth = await import("../dist/stealth.js");
const { PUSH_TAP } = await import("../dist/native-browser-push.js");
const { RTC_TAP } = await import("../dist/native-browser-streams.js");
const repo = new URL("../../../../", import.meta.url);
const source = (path) => readFile(new URL(path, repo), "utf8");

const MANIFESTS = [
  "apps/chrome-extension/manifest.native.json",
  "browser/apps/extension/manifest.json",
];

test("every web-accessible resource uses a dynamic URL", async () => {
  for (const path of MANIFESTS) {
    const manifest = JSON.parse(await source(path));
    for (const entry of manifest.web_accessible_resources ?? [])
      assert.equal(entry.use_dynamic_url, true, `${path}: ${JSON.stringify(entry.resources)}`);
  }
});

test("at rest a page sees nothing of the agent", () => {
  const report = stealth.judgeStealth({}, { runtimeEnabled: false, injectedScripts: [] });
  assert.equal(report.detectable, false);
  assert.deepEqual(report.activeTaps, []);
});

test("the cursor never paints through the page's own world", async () => {
  const cursor = await source("browser/packages/engine/src/native-browser-cursor.ts");
  assert.doesNotMatch(cursor, /Runtime\.evaluate|world: "MAIN"/);
  const worker = await source("apps/chrome-extension/src/orb/orb-worker.ts");
  assert.doesNotMatch(worker, /world: "MAIN"/);
  const painter = await source("browser/packages/engine/src/cursor-page.ts");
  // Every event goes over the isolated-world bus, never the page's window.
  assert.doesNotMatch(painter, /(^|[^.\w])dispatchEvent\(|window\.(add|remove)EventListener\(/m);
  for (const path of [
    "apps/chrome-extension/src/orb/orb-overlay.ts",
    "apps/chrome-extension/src/orb/cursor-controls.ts",
  ])
    assert.doesNotMatch(await source(path), /window\.(addEventListener|dispatchEvent)\(CURSOR_/);
});

test("tap names and sources carry nothing that names Graft", () => {
  for (const tap of [PUSH_TAP, RTC_TAP]) {
    assert.doesNotMatch(tap.binding + tap.off, /graft/i);
    assert.match(tap.binding, /^_[0-9a-z]+$/);
  }
});

test("the ledger reports a tap and turns Runtime off on the last stop", async () => {
  const tabId = 41;
  const push = { ...PUSH_TAP, source: "/*push*/" };
  const rtc = { ...RTC_TAP, source: "/*rtc*/" };
  await realtime.installTap(tabId, push);
  await realtime.installTap(tabId, rtc);
  const armed = stealth.judgeStealth(
    {},
    {
      runtimeEnabled: stealth.tapsNeedRuntime(tabId),
      injectedScripts: [],
      activeTaps: stealth.activeTaps(tabId),
    },
  );
  assert.equal(armed.detectable, true);
  assert.equal(armed.activeTaps.length, 2);
  assert.ok(armed.signals.some((line) => line.includes(PUSH_TAP.label)));
  assert.ok(armed.signals.some((line) => line.startsWith("the Runtime domain is enabled")));

  sent.length = 0;
  await realtime.removeTap(tabId, push, "s1");
  assert.ok(!sent.some((call) => call.method === "Runtime.disable"), "another tap still needs it");
  assert.ok(sent.some((call) => String(call.params?.expression).includes(PUSH_TAP.off)));
  await realtime.removeTap(tabId, rtc, "s2");
  assert.ok(sent.some((call) => call.method === "Runtime.disable"));
  assert.deepEqual(stealth.activeTaps(tabId), []);
  assert.equal(stealth.tapsNeedRuntime(tabId), false);
});

test("console capture keeps Runtime on past the last tap, and a tap keeps it past console stop", async () => {
  const tabId = 42;
  const tap = { ...PUSH_TAP, source: "" };
  await events.enableConsoleCapture(tabId);
  await realtime.installTap(tabId, tap);
  sent.length = 0;
  await realtime.removeTap(tabId, tap, "");
  assert.ok(!sent.some((call) => call.method === "Runtime.disable"));
  await realtime.installTap(tabId, tap);
  sent.length = 0;
  await events.disableConsoleCapture(tabId);
  assert.ok(!sent.some((call) => call.method === "Runtime.disable"));
  await realtime.removeTap(tabId, tap, "");
  assert.ok(sent.some((call) => call.method === "Runtime.disable"));
});

test("a debugger detach disarms the tap and restores the page through chrome.scripting", async () => {
  const tabId = 43;
  await realtime.installTap(tabId, { ...RTC_TAP, source: "" });
  realtime.dropTap(tabId, RTC_TAP);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(stealth.activeTaps(tabId), []);
  const call = scripted.at(-1);
  assert.equal(call.world, "MAIN");
  assert.deepEqual(call.args, [RTC_TAP.off]);
});
