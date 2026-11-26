// page.streams integrity: sockets opened before start() get their URL from the network recorder,
// ring evictions are counted, `since` pages without gaps, binary frames keep bounded base64.
import assert from "node:assert/strict";
import test from "node:test";

const events = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async () => ({}),
    onEvent: { addListener: (listener) => events.push(listener) },
    onDetach: { addListener() {} },
  },
  tabs: { onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
  storage: {},
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  },
};
const realtime = await import("../dist/native-browser-realtime.js");
const { streamsCall, streamEvent, streamsTabForTest, streamsRecorderForTest } =
  await import("../dist/native-browser-streams.js");

const recorded = new Map();
streamsRecorderForTest((tabId) => recorded.get(tabId));
const frame = (tabId, id, payloadData, opcode = 1) =>
  streamEvent(tabId, "Network.webSocketFrameReceived", {
    requestId: id,
    response: { opcode, payloadData },
  });

test("a socket opened before start() takes its URL from the network recorder", async () => {
  recorded.set(
    11,
    new Map([
      ["ws1", { url: "wss://socket.test/watch/abc", type: "WebSocket", status: 101, done: false }],
    ]),
  );
  streamsTabForTest(11);
  frame(11, "ws1", '{"t":"move"}');
  const [first] = await streamsCall(11, "list", {});
  assert.equal(first.url, "wss://socket.test/watch/abc");
  const { sockets } = await streamsCall(11, "state", {});
  assert.deepEqual(
    sockets.map(({ stream, url, opened, frames }) => ({ stream, url, opened, frames })),
    [{ stream: "ws1", url: "wss://socket.test/watch/abc", opened: "before-attach", frames: 1 }],
  );
  assert.ok(sockets[0].lastAt > 0);
});

test("an idle known socket shows in state() with zero frames", async () => {
  recorded.set(
    12,
    new Map([["irc", { url: "wss://irc.test/", type: "WebSocket", status: 101, done: false }]]),
  );
  streamsTabForTest(12);
  streamEvent(12, "Network.webSocketCreated", { requestId: "seen", url: "wss://live.test/s" });
  const state = await streamsCall(12, "state", {});
  assert.equal(state.dropped, 0);
  const byId = Object.fromEntries(state.sockets.map((s) => [s.stream, s]));
  assert.equal(byId.irc.frames, 0);
  assert.equal(byId.irc.opened, "before-attach");
  assert.equal(byId.seen.opened, "observed");
  assert.equal(byId.seen.frames, 0);
});

test("overflow is counted and `since` pages give every retained frame once", async () => {
  streamsTabForTest(13);
  streamEvent(13, "Network.webSocketCreated", { requestId: "p", url: "wss://busy.test/" });
  const firstPage = await streamsCall(13, "list", { since: 0 });
  assert.deepEqual(firstPage, { frames: [], next: 0, missed: 0 });
  for (let i = 0; i < 300; i++) frame(13, "p", `n${i}`);
  assert.equal((await streamsCall(13, "state", {})).dropped, 100);
  // Without `since` the plain array stays, as before.
  assert.equal((await streamsCall(13, "list", {})).length, realtime.RING_MAX);
  const seen = [];
  let cursor = 0;
  let page = await streamsCall(13, "list", { since: cursor, limit: 64 });
  assert.equal(page.missed, 100);
  while (page.frames.length) {
    seen.push(...page.frames.map((f) => f.data));
    assert.ok(page.next > cursor);
    cursor = page.next;
    page = await streamsCall(13, "list", { since: cursor, limit: 64 });
    assert.equal(page.missed, 0);
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 200 }, (_, i) => `n${i + 100}`),
  );
  frame(13, "p", "late");
  const tail = await streamsCall(13, "list", { since: cursor });
  assert.deepEqual(
    tail.frames.map((f) => f.data),
    ["late"],
  );
});

test("binary frames keep bounded base64", async () => {
  streamsTabForTest(14);
  streamEvent(14, "Network.webSocketCreated", { requestId: "b", url: "wss://bin.test/" });
  const small = Buffer.from([1, 2, 3, 250, 251]).toString("base64");
  frame(14, "b", small, 2);
  const big = Buffer.alloc(20_000, 7).toString("base64");
  frame(14, "b", big, 2);
  const [one, two] = await streamsCall(14, "list", {});
  assert.equal(one.format, "binary");
  assert.equal(one.data, small);
  assert.equal(one.bytes, 5);
  assert.equal(one.truncated, false);
  assert.deepEqual([...Buffer.from(one.data, "base64")], [1, 2, 3, 250, 251]);
  assert.equal(two.format, "binary");
  assert.equal(two.truncated, true);
  assert.equal(two.bytes, 20_000);
  assert.equal(two.data.length, realtime.BINARY_MAX);
  assert.equal(Buffer.from(two.data, "base64").length, (realtime.BINARY_MAX / 4) * 3);
});
