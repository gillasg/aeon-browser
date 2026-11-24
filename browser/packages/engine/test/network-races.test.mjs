import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  debugger: {
    sendCommand: async () => ({}),
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: { get: async () => ({}), onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, id: "x" },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
};

const scopes = await import("../dist/native-browser-network-scopes.js");
const { networkRecorderForTest } = await import("../dist/native-browser-network.js");

function recordingSend(log, hang = new Set()) {
  return (target, method) => {
    log.push(method);
    return hang.has(method) ? new Promise(() => {}) : Promise.resolve({});
  };
}

test("auto-attach pauses children only while capture is on", () => {
  scopes.setCaptureActive(3, true);
  assert.deepEqual(scopes.autoAttachParams(3), {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  scopes.setCaptureActive(3, false);
  assert.equal(scopes.autoAttachParams(3).waitForDebuggerOnStart, false);
});

test("an OOPIF that starts paused gets Network.enable before it is resumed", async () => {
  const log = [];
  await scopes.attachChild(
    3,
    {
      sessionId: "s1",
      waitingForDebugger: true,
      targetInfo: { type: "iframe", url: "https://pay.test/" },
    },
    recordingSend(log),
  );
  assert.deepEqual(log, ["Network.enable", "Runtime.runIfWaitingForDebugger"]);
});

test("the 2 s cap resumes a child even when Network.enable never answers", async () => {
  const log = [];
  const started = Date.now();
  await scopes.startChild(3, "s2", true, true, recordingSend(log, new Set(["Network.enable"])), 50);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(log, ["Network.enable", "Runtime.runIfWaitingForDebugger"]);
  assert.equal(scopes.RESUME_CAP_MS, 2000);
});

test("a paused child of another type is still resumed", async () => {
  const log = [];
  await scopes.attachChild(
    3,
    { sessionId: "s3", waitingForDebugger: true, targetInfo: { type: "other" } },
    recordingSend(log),
  );
  assert.deepEqual(log, ["Runtime.runIfWaitingForDebugger"]);
});

const request = (requestId, url, extra = {}) => ({
  requestId,
  type: "Document",
  request: { url, method: "GET", headers: { accept: "*/*" } },
  ...extra,
});

test("redirect hops keep their own extra info, and a hop without it closes without it", () => {
  const net = networkRecorderForTest();
  net.event("Network.requestWillBeSent", request("r", "https://a.test/1"));
  net.event("Network.responseReceivedExtraInfo", {
    requestId: "r",
    headers: { "set-cookie": "hop0=1" },
  });
  net.event(
    "Network.requestWillBeSent",
    request("r", "https://a.test/2", {
      redirectResponse: { status: 302, headers: { location: "/2" } },
    }),
  );
  // Hop 1: cached, no extra info.
  net.event(
    "Network.requestWillBeSent",
    request("r", "https://a.test/3", {
      redirectResponse: { status: 301, headers: { location: "/3" } },
    }),
  );
  net.event("Network.responseReceived", {
    requestId: "r",
    response: { status: 200, headers: { "content-type": "text/html" } },
  });
  net.event("Network.responseReceivedExtraInfo", {
    requestId: "r",
    headers: { "set-cookie": "final=1" },
  });
  net.event("Network.loadingFinished", { requestId: "r", encodedDataLength: 10 });
  const [entry] = net.entries();
  assert.equal(entry.redirects.length, 2);
  assert.equal(entry.redirects[0].hop, 0);
  assert.equal(entry.redirects[0].headers["set-cookie"], "hop0=1");
  assert.equal(entry.redirects[1].hop, 1);
  assert.equal(entry.redirects[1].headers["set-cookie"], undefined);
  assert.equal(entry.redirects[1].extraInfo, false);
  assert.equal(entry.responseHeaders["set-cookie"], "final=1");
  assert.equal(entry.url, "https://a.test/3");
});

test("an aborted request is kept as aborted, not failed", () => {
  const net = networkRecorderForTest();
  net.event("Network.requestWillBeSent", request("x", "https://a.test/api", { type: "Fetch" }));
  net.event("Network.loadingFailed", {
    requestId: "x",
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });
  const [entry] = net.entries();
  assert.equal(entry.aborted, true);
  assert.equal(entry.failed, undefined);
  assert.equal(entry.done, true);
});

test("stopping capture flushes parked hops as partial entries", () => {
  const net = networkRecorderForTest();
  net.event("Network.requestWillBeSent", request("p", "https://a.test/slow", { type: "Fetch" }));
  net.event("Network.responseReceivedExtraInfo", { requestId: "p", headers: { "x-hop": "1" } });
  net.stop();
  const [entry] = net.entries();
  assert.equal(entry.partial, true);
  assert.equal(entry.responseHeaders["x-hop"], "1");
});
