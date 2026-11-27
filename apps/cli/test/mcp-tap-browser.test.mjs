import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventHub } from "../dist/mcp-events.js";
import { BrowserTapSource } from "../dist/mcp-tap-browser.js";

// graft/tap wired to the browser source: a fake connected browser answers the cells the source
// sends, the way the engine's page.streams would (a ring with seq numbers and a waitFor).

function fakeBrowser(activeTab = 9) {
  const state = { started: new Map(), frames: [], seq: 0, cells: [], waiters: [] };
  const wake = () => state.waiters.splice(0).forEach((resolve) => resolve());
  const run = async (code) => {
    state.cells.push(code);
    if (code.includes("browser.activeTab()")) return activeTab;
    const tab = Number(/browser\.tab\((\d+)\)/.exec(code)?.[1]);
    if (code.includes("streams.stop()")) {
      state.started.delete(tab);
      wake();
      if (code.includes("streams.start({})")) state.started.set(tab, { webrtc: false });
      return true;
    }
    if (code.includes("streams.start(")) {
      state.started.set(tab, { webrtc: code.includes("webrtc: true") });
      return state.seq;
    }
    const since = Number(/const s = (\d+)/.exec(code)?.[1]);
    const ready = () => state.frames.filter((f) => f.tab === tab && f.seq > since);
    if (!ready().length) await new Promise((resolve) => state.waiters.push(resolve));
    return state.started.has(tab) ? ready() : [];
  };
  const push = (tab, frame) => {
    state.frames.push({ tab, seq: ++state.seq, at: Date.now(), ...frame });
    wake();
  };
  return { state, run, push };
}

async function hub(source) {
  const dir = await mkdtemp(join(tmpdir(), "graft-tap-live-"));
  const sent = [];
  const events = new EventHub({
    dataDirectory: dir,
    notify: (method, params) => sent.push({ method, params }),
    pollMs: 100000,
    tap: source,
  });
  return { events, sent, done: () => rm(dir, { recursive: true, force: true }) };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

test("live tap: arms the active tab, delivers filtered and scrubbed frames, disarms", async () => {
  const browser = fakeBrowser();
  const { events, sent, done } = await hub(new BrowserTapSource(browser.run));
  const { subscriptionId } = await events.subscribe({
    name: "graft/tap",
    filter: { kind: "ws", dir: "in", where: { key: "type", equals: "tick" } },
  });
  assert.deepEqual(browser.state.started.get(9), { webrtc: false });
  browser.push(9, { kind: "ws", direction: "sent", url: "wss://a.test/x", data: "{}", json: {} });
  browser.push(9, {
    kind: "ws",
    direction: "received",
    url: "wss://a.test/x",
    data: "",
    json: { type: "other" },
  });
  browser.push(9, {
    kind: "ws",
    direction: "received",
    url: "wss://a.test/x",
    data: "",
    json: { type: "tick", token: "sk-ant-api03-" + "a".repeat(90) },
  });
  await wait(60);
  assert.equal(sent.length, 1);
  const { payload } = sent[0].params;
  assert.equal(payload.tab, "t9");
  assert.equal(payload.dir, "in");
  assert.equal(payload.data.type, "tick");
  assert.ok(!JSON.stringify(payload).includes("a".repeat(90)));
  await events.unsubscribe({ subscriptionId });
  assert.equal(browser.state.started.size, 0);
  assert.ok(browser.state.cells.some((code) => code.includes("streams.stop()")));
  await events.close();
  await done();
});

test("live tap: webrtc arms the page script; hub close always stops the tap", async () => {
  const browser = fakeBrowser();
  const { events, done } = await hub(new BrowserTapSource(browser.run));
  await events.subscribe({ name: "graft/tap", filter: { tab: "t4", kind: "ws" } });
  const rtc = await events.subscribe({ name: "graft/tap", filter: { tab: "t4", kind: "webrtc" } });
  assert.deepEqual(browser.state.started.get(4), { webrtc: true });
  await events.unsubscribe({ subscriptionId: rtc.subscriptionId });
  assert.deepEqual(browser.state.started.get(4), { webrtc: false });
  await events.close();
  assert.equal(browser.state.started.size, 0);
  await done();
});
