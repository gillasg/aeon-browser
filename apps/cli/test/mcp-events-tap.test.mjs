import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeTaps } from "@browserkit/engine/stealth";
import { EventHub } from "../dist/mcp-events.js";

// graft/tap over EventHub with a fake browser side: no Chrome, no model. The tap ledger is the
// engine's real one, so these tests see exactly what page.stealthCheck() would report.

function fakeSource(activeTab = 7) {
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    resolveTab: (ref) => ref ?? activeTab,
    install: (tab, kind) => calls.push(["install", tab, kind]),
    remove: (tab, kind, state) => calls.push(["remove", tab, kind, state.runtimeInUse]),
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (frame) => listeners.forEach((listener) => listener(frame)),
    get listening() {
      return listeners.size;
    },
  };
}

async function hub(source) {
  const dir = await mkdtemp(join(tmpdir(), "graft-tap-"));
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
const labels = (tab) => activeTaps(tab).map((tap) => tap.label);

test("graft/tap: listed, subscribe arms, frames emit, unsubscribe disarms", async () => {
  const source = fakeSource();
  const { events, sent, done } = await hub(source);
  const names = events.list().events.map((event) => event.name);
  assert.equal(names.length, 5);
  assert.ok(names.includes("graft/tap") && names.includes("graft/routine.fired"));

  const result = await events.subscribe({ name: "graft/tap", filter: { tab: "t3", kind: "ws" } });
  assert.ok(result.subscriptionId && result.cursor === "0");
  assert.deepEqual(labels(3), ["MCP live tap (ws)"]);
  source.emit({ tab: 3, kind: "ws", dir: "in", url: "wss://x.test/feed", data: '{"a":1}' });
  await wait(30);
  assert.equal(sent.length, 1);
  const { name, payload, subscriptionId } = sent[0].params;
  assert.equal(sent[0].method, "notifications/events/emitted");
  assert.equal(name, "graft/tap");
  assert.equal(subscriptionId, result.subscriptionId);
  assert.equal(payload.tab, "t3");
  assert.equal(payload.dropped, 0);
  assert.equal(payload.data, '{"a":1}');
  assert.ok(!("truncated" in payload));

  assert.deepEqual(await events.unsubscribe({ subscriptionId: result.subscriptionId }), {
    unsubscribed: true,
  });
  assert.deepEqual(labels(3), []);
  assert.deepEqual(source.calls.at(-1), ["remove", 3, "ws", false]);
  assert.equal(source.listening, 0);
  await assert.rejects(events.poll({ subscriptionId: result.subscriptionId }), /Unknown/);
  await done();
});

test("graft/tap: numeric and default tab refs, kind all arms every kind", async () => {
  const source = fakeSource(11);
  const { events, done } = await hub(source);
  const a = await events.subscribe({ name: "graft/tap", filter: { tab: 12, kind: "sse" } });
  const b = await events.subscribe({ name: "graft/tap" });
  assert.deepEqual(labels(12), ["MCP live tap (sse)"]);
  assert.equal(labels(11).length, 3);
  await assert.rejects(events.subscribe({ name: "graft/tap", filter: { kind: "x" } }), /kind/);
  await events.unsubscribe({ subscriptionId: a.subscriptionId });
  await events.unsubscribe({ subscriptionId: b.subscriptionId });
  assert.equal(labels(11).length + labels(12).length, 0);
  await done();
});

test("graft/tap: zero-model filtering never wakes the client for non-matching frames", async () => {
  const source = fakeSource();
  const { events, sent, done } = await hub(source);
  await events.subscribe({
    name: "graft/tap",
    filter: {
      tab: 7,
      kind: "ws",
      dir: "in",
      match: "price",
      where: { key: "type", equals: "tick" },
    },
  });
  const base = { tab: 7, kind: "ws", dir: "in", url: "wss://x.test/s" };
  source.emit({ ...base, data: '{"type":"tick","price":1}' });
  source.emit({ ...base, kind: "sse", data: '{"type":"tick","price":2}' });
  source.emit({ ...base, dir: "out", data: '{"type":"tick","price":3}' });
  source.emit({ ...base, tab: 8, data: '{"type":"tick","price":4}' });
  source.emit({ ...base, data: '{"type":"other","price":5}' });
  source.emit({ ...base, data: '{"type":"tick","volume":6}' });
  source.emit({ ...base, data: "not json price" });
  await wait(250);
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.payload.data, /"price":1/);
  await events.close();
  await done();
});

test("graft/tap: glob match on the url", async () => {
  const source = fakeSource();
  const { events, sent, done } = await hub(source);
  await events.subscribe({ name: "graft/tap", filter: { kind: "ws", match: "wss://a.test/*" } });
  source.emit({ tab: 7, kind: "ws", dir: "in", url: "wss://b.test/x", data: "1" });
  source.emit({ tab: 7, kind: "ws", dir: "in", url: "wss://a.test/x", data: "2" });
  await wait(30);
  assert.deepEqual(
    sent.map((item) => item.params.payload.data),
    ["2"],
  );
  await events.close();
  await done();
});

test("graft/tap: <=10 msgs/s, drop-oldest ring of 256 and dropped counter", async () => {
  const source = fakeSource();
  const { events, sent, done } = await hub(source);
  await events.subscribe({ name: "graft/tap", filter: { kind: "ws" } });
  for (let index = 0; index < 300; index++)
    source.emit({ tab: 7, kind: "ws", dir: "in", data: String(index) });
  await wait(1050);
  assert.ok(sent.length >= 3 && sent.length <= 11, `sent ${sent.length} in ~1s`);
  const first = sent[0].params.payload;
  // 300 frames into a 256 ring: the 44 oldest are dropped and reported once.
  assert.equal(first.data, "44");
  assert.equal(first.dropped, 44);
  assert.equal(sent[1].params.payload.dropped, 0);
  for (let index = 1; index < sent.length; index++)
    assert.ok(Number(sent[index].params.payload.data) > 44);
  await events.close();
  const after = sent.length;
  await wait(250);
  assert.equal(sent.length, after, "no timer survives close");
  await done();
});

test("graft/tap: payloads over 4 KB are truncated and flagged", async () => {
  const source = fakeSource();
  const { events, sent, done } = await hub(source);
  await events.subscribe({ name: "graft/tap", filter: { kind: "sse" } });
  source.emit({ tab: 7, kind: "sse", dir: "in", data: "é".repeat(5000) });
  source.emit({ tab: 7, kind: "sse", dir: "in", data: { list: "x".repeat(9000) } });
  await wait(250);
  assert.equal(sent.length, 2);
  for (const item of sent) {
    assert.equal(item.params.payload.truncated, true);
    assert.ok(Buffer.byteLength(item.params.payload.data) <= 4096);
  }
  await events.close();
  await done();
});

test("graft/tap: headers are sealed, bodies scrubbed and canary-checked", async () => {
  const source = fakeSource();
  const { events, sent, done } = await hub(source);
  await events.subscribe({ name: "graft/tap", filter: { kind: "ws" } });
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXBhcnQ";
  source.emit({
    tab: 7,
    kind: "ws",
    dir: "out",
    url: "wss://x.test/s",
    headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz", cookie: "sid=secret-value" },
    data: { token: "tok-123456", note: `auth ${jwt}`, handle: "graft-sealed:abcdefghijkl" },
  });
  await wait(30);
  const { payload } = sent[0].params;
  for (const value of Object.values(payload.headers))
    assert.match(value, /^graft-sealed:[a-z0-9]{12}$/);
  const text = JSON.stringify(payload.data);
  assert.ok(!text.includes("tok-123456") && !text.includes(jwt) && !text.includes("graft-sealed:"));
  assert.ok(!JSON.stringify(payload).includes("secret-value"));
  await events.close();
  await done();
});

test("ST-3 invariant: ref-counted disarm, and close disarms every tap", async () => {
  const source = fakeSource();
  const { events, done } = await hub(source);
  const one = await events.subscribe({ name: "graft/tap", filter: { tab: 20, kind: "webrtc" } });
  const two = await events.subscribe({ name: "graft/tap", filter: { tab: 20, kind: "webrtc" } });
  await events.subscribe({ name: "graft/tap", filter: { tab: 21 } });
  assert.equal(source.calls.filter((call) => call[0] === "install" && call[1] === 20).length, 1);
  assert.deepEqual(labels(20), ["MCP live tap (webrtc)"]);

  // (c) the first of two subscriptions ends: the tap stays armed.
  await events.unsubscribe({ subscriptionId: one.subscriptionId });
  assert.deepEqual(labels(20), ["MCP live tap (webrtc)"]);
  assert.ok(!source.calls.some((call) => call[0] === "remove"));
  // (a) the last one ends: disarmed, originals restored, Runtime released.
  await events.unsubscribe({ subscriptionId: two.subscriptionId });
  assert.deepEqual(labels(20), []);
  assert.deepEqual(source.calls.at(-1), ["remove", 20, "webrtc", false]);

  // (b) abrupt disconnect: close disarms everything still armed.
  assert.equal(labels(21).length, 3);
  await events.close();
  assert.equal(labels(21).length, 0);
  assert.equal(source.calls.filter((call) => call[0] === "remove" && call[1] === 21).length, 3);
  assert.equal(source.listening, 0);
  await done();
});

test("graft/tap without a browser source fails cleanly and arms nothing", async () => {
  const { events, done } = await hub(undefined);
  await assert.rejects(events.subscribe({ name: "graft/tap", filter: { tab: 30 } }), /browser/);
  assert.deepEqual(labels(30), []);
  await done();
});
