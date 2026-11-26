import assert from "node:assert/strict";
import test from "node:test";

const sent = [];
const events = [];
const removed = [];
const detached = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (target, method, params) => {
      sent.push({ tabId: target.tabId, method, params });
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      return {};
    },
    onEvent: { addListener: (listener) => events.push(listener) },
    onDetach: { addListener: (listener) => detached.push(listener) },
  },
  tabs: { onRemoved: { addListener: (listener) => removed.push(listener) } },
  runtime: { onInstalled: { addListener() {} } },
  storage: {},
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  },
};
const realtime = await import("../dist/native-browser-realtime.js");
const streams = await import("../dist/native-browser-streams.js");
const push = await import("../dist/native-browser-push.js");
const { streamsCall, onStreamFrame, streamsActive } = streams;
const { pushCall, pushActive } = push;
const { installEngineListeners } = await import("../dist/native-engine-install.js");
try {
  installEngineListeners();
} catch {
  // Unrelated modules need chrome APIs this fake leaves out; ours install first-come.
}

const fire = (tabId, method, params) => {
  for (const listener of events) listener({ tabId }, method, params);
};
const methods = (tabId) => sent.filter((call) => call.tabId === tabId).map((call) => call.method);
const SECRET = "sk_live_ABCDEFGHIJKLMNOP";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";

test("idle tabs cost nothing: no CDP call and no state until start or waitFor", async () => {
  fire(1, "Network.webSocketCreated", { requestId: "w", url: "wss://x.test/live" });
  fire(1, "Network.webSocketFrameReceived", {
    requestId: "w",
    response: { opcode: 1, payloadData: "{}" },
  });
  fire(1, "BackgroundService.backgroundServiceEventReceived", {
    backgroundServiceEvent: { service: "pushMessaging" },
  });
  assert.deepEqual(methods(1), []);
  assert.equal(streamsActive(1), false);
  assert.equal(pushActive(1), false);
  await assert.rejects(streamsCall(1, "list", {}), /Not streaming/);
  await assert.rejects(pushCall(1, "list", {}), /Not observing/);
  assert.deepEqual(await streamsCall(1, "state", {}), { streaming: false, frames: 0 });
  assert.deepEqual(methods(1), []);
});

test("start is idempotent; stop tears down the WebRTC tap and is safe twice", async () => {
  await streamsCall(2, "start", {});
  await streamsCall(2, "start", {});
  assert.deepEqual(methods(2), ["Network.enable"]);
  const reply = await streamsCall(2, "start", { webrtc: true });
  assert.equal(reply.webrtc, true);
  await streamsCall(2, "start", { webrtc: true });
  assert.equal(methods(2).filter((m) => m === "Runtime.addBinding").length, 1);
  assert.deepEqual(await streamsCall(2, "stop", {}), { stopped: true });
  assert.ok(methods(2).includes("Page.removeScriptToEvaluateOnNewDocument"));
  assert.ok(methods(2).includes("Runtime.removeBinding"));
  assert.equal(streamsActive(2), false);
  assert.deepEqual(await streamsCall(2, "stop", {}), { stopped: false });
});

test("WebSocket, SSE and WebRTC frames are captured, filtered, scrubbed and described", async () => {
  await streamsCall(3, "start", { webrtc: true });
  const heard = [];
  const off = onStreamFrame((tabId, frame) => heard.push([tabId, frame.kind]));
  fire(3, "Network.webSocketCreated", {
    requestId: "w1",
    url: "wss://chat.test/rooms/12345/live?token=abc123",
  });
  fire(3, "Network.webSocketFrameReceived", {
    requestId: "w1",
    response: {
      opcode: 1,
      payloadData: JSON.stringify({ type: "msg", user: { id: 1 }, token: SECRET }),
    },
  });
  fire(3, "Network.webSocketFrameSent", {
    requestId: "w1",
    response: { opcode: 1, payloadData: `auth Bearer ${JWT}` },
  });
  fire(3, "Network.webSocketFrameReceived", {
    requestId: "w1",
    response: { opcode: 2, payloadData: "AAAA" },
  });
  fire(3, "Network.requestWillBeSent", {
    requestId: "e1",
    type: "EventSource",
    request: { url: "https://feed.test/sse" },
  });
  fire(3, "Network.eventSourceMessageReceived", {
    requestId: "e1",
    eventName: "price",
    data: '{"symbol":"X","price":1.5,"apiKey":"zzzz"}',
  });
  fire(3, "Runtime.bindingCalled", {
    name: streams.RTC_TAP.binding,
    payload: JSON.stringify({
      direction: "received",
      label: "game",
      url: "https://p2p.test#datachannel:game",
      data: '{"move":3}\n{"move":4}',
    }),
  });
  off();
  const all = await streamsCall(3, "list", {});
  assert.equal(all.length, 5);
  assert.deepEqual(
    heard.map((h) => h[1]),
    ["ws", "ws", "ws", "sse", "webrtc"],
  );
  const dump = JSON.stringify(all);
  for (const leak of [SECRET, JWT, "abc123", "zzzz"]) assert.ok(!dump.includes(leak), leak);
  assert.equal(all[0].json.token, "[redacted]");
  assert.equal(all[0].format, "json");
  assert.equal(all[2].format, "binary");
  assert.equal(all[2].data, "AAAA");
  assert.equal(all[2].bytes, 3);
  assert.equal(all[4].format, "ndjson");
  assert.equal((await streamsCall(3, "list", { kind: "sse" }))[0].event, "price");
  assert.equal((await streamsCall(3, "list", { direction: "sent" })).length, 1);
  assert.equal((await streamsCall(3, "list", { url: "rooms/\\d+", regex: true })).length, 3);
  assert.equal((await streamsCall(3, "list", { field: "user.id", equals: 1 })).length, 1);
  assert.equal((await streamsCall(3, "list", { kind: ["sse", "webrtc"] })).length, 2);
  const described = await streamsCall(3, "describe", {});
  const ws = described.find((d) => d.protocol === "ws");
  assert.equal(ws.url, "wss://chat.test/rooms/:id/live");
  assert.equal(ws.samples, 3);
  assert.equal(ws.direction, "received+sent");
  assert.equal(ws.schema["user.id"], "number");
  assert.equal(ws.schema.type, "string");
  const sse = described.find((d) => d.protocol === "sse");
  assert.deepEqual(sse.events, ["price"]);
  assert.equal(sse.schema.price, "number");
  assert.equal(described.find((d) => d.protocol === "webrtc").schema.move, "number");
  await streamsCall(3, "stop", {});
});

test("the ring stays bounded and payloads are capped", async () => {
  await streamsCall(4, "start", {});
  fire(4, "Network.webSocketCreated", { requestId: "w", url: "wss://x.test/s" });
  for (let i = 0; i < 260; i++)
    fire(4, "Network.webSocketFrameReceived", {
      requestId: "w",
      response: { opcode: 1, payloadData: `n${i}` },
    });
  fire(4, "Network.webSocketFrameReceived", {
    requestId: "w",
    response: { opcode: 1, payloadData: "y".repeat(20000) },
  });
  const all = await streamsCall(4, "list", {});
  assert.equal(all.length, realtime.RING_MAX);
  assert.equal(all.at(-1).truncated, true);
  assert.equal(all.at(-1).data.length, realtime.PAYLOAD_MAX);
  assert.equal(all.at(-1).bytes, 20000);
  assert.equal((await streamsCall(4, "list", { limit: 5 })).length, 5);
  await streamsCall(4, "stop", {});
});

test("waitFor starts lazily, resolves on the next match and returns null at the timeout", async () => {
  const waiting = streamsCall(5, "waitFor", { url: "/live", match: "goal", timeoutMs: 2000 });
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(methods(5), ["Network.enable"]);
  fire(5, "Network.webSocketCreated", { requestId: "w", url: "wss://x.test/live" });
  fire(5, "Network.webSocketFrameReceived", {
    requestId: "w",
    response: { opcode: 1, payloadData: "ping" },
  });
  fire(5, "Network.webSocketFrameReceived", {
    requestId: "w",
    response: { opcode: 1, payloadData: "goal!" },
  });
  assert.equal((await waiting).data, "goal!");
  const started = Date.now();
  assert.equal(await streamsCall(5, "waitFor", { match: "never", timeoutMs: 30 }), null);
  assert.ok(Date.now() - started < 1000);
  const pending = streamsCall(5, "waitFor", { match: "x", timeoutMs: 5000 });
  for (const listener of removed) listener(5);
  assert.equal(await pending, null);
  assert.equal(streamsActive(5), false);
});

test("notifications: lazy BackgroundService/ServiceWorker, scrubbed capture, badge, clean stop", async () => {
  assert.deepEqual(methods(6), []);
  await pushCall(6, "start", {});
  await pushCall(6, "start", {});
  const started = methods(6);
  assert.equal(started.filter((m) => m === "BackgroundService.startObserving").length, 2);
  assert.equal(started.filter((m) => m === "ServiceWorker.enable").length, 1);
  const services = sent
    .filter((c) => c.tabId === 6 && c.method === "BackgroundService.startObserving")
    .map((c) => c.params.service);
  assert.deepEqual(services, ["pushMessaging", "notifications"]);
  const waiting = pushCall(6, "waitFor", { kind: "push", timeoutMs: 2000 });
  fire(6, "BackgroundService.backgroundServiceEventReceived", {
    backgroundServiceEvent: {
      service: "pushMessaging",
      origin: "https://mail.test",
      eventName: "Push event dispatched",
      eventMetadata: [{ key: "payload", value: `{"subject":"hi","access_token":"${SECRET}"}` }],
    },
  });
  const got = await waiting;
  assert.equal(got.kind, "push");
  assert.ok(!JSON.stringify(got).includes(SECRET));
  const tap = (message) =>
    fire(6, "Runtime.bindingCalled", {
      name: push.PUSH_TAP.binding,
      payload: JSON.stringify(message),
    });
  tap({
    kind: "notification",
    title: "New mail",
    body: `code Bearer ${JWT}`,
    url: "https://mail.test/?sid=abcdef",
  });
  tap({ kind: "badge", event: "set", count: 4 });
  tap({ kind: "title", title: "(3) Inbox", count: 3 });
  tap({ kind: "title", title: "(3) Inbox - x", count: 3 });
  tap({ kind: "title", title: "(5) Inbox", count: 5 });
  tap({ kind: "bogus" });
  const all = await pushCall(6, "list", {});
  assert.deepEqual(
    all.map((e) => e.kind),
    ["push", "notification", "badge", "title", "title"],
  );
  const dump = JSON.stringify(all);
  assert.ok(!dump.includes(JWT) && !dump.includes("abcdef"));
  assert.deepEqual(await pushCall(6, "badge", {}), { badge: 4, unread: 5 });
  assert.equal((await pushCall(6, "list", { kind: "title" })).at(-1).count, 5);
  assert.deepEqual(await pushCall(6, "stop", {}), { stopped: true });
  const after = methods(6);
  assert.equal(after.filter((m) => m === "BackgroundService.stopObserving").length, 2);
  assert.ok(after.includes("ServiceWorker.disable"));
  assert.ok(after.includes("Runtime.removeBinding"));
  assert.equal(pushActive(6), false);
  fire(6, "Runtime.bindingCalled", {
    name: push.PUSH_TAP.binding,
    payload: '{"kind":"badge","count":1}',
  });
  await assert.rejects(pushCall(6, "list", {}), /Not observing/);
});

test("a debugger detach drops the tab's taps and wakes waiters", async () => {
  await pushCall(7, "start", {});
  const pending = pushCall(7, "waitFor", { timeoutMs: 5000 });
  for (const listener of detached) listener({ tabId: 7 });
  assert.equal(await pending, null);
  assert.equal(pushActive(7), false);
});

test("scrubbing covers JSON fields, headers, query secrets and known key formats", () => {
  const { scrubText, scrubValue } = realtime;
  assert.equal(scrubText("Cookie: a=b; c=d"), "Cookie: [redacted]");
  assert.equal(scrubText("x?api_key=12345&y=1"), "x?api_key=[redacted]&y=1");
  assert.equal(scrubText("ghp_abcdefghijklmnop"), "[redacted]");
  assert.deepEqual(scrubValue({ Authorization: "x", nested: { password: "p", ok: 1 } }), {
    Authorization: "[redacted]",
    nested: { password: "[redacted]", ok: 1 },
  });
});
