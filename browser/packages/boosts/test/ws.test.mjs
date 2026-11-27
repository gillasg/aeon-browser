// GM.webSocket: the page half and the service-worker half joined by an in-memory transport,
// against a real local WebSocket server.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  KEEP_ALIVE_MS,
  MAX_SOCKETS,
  MAX_TOTAL_SOCKETS,
  socketHub,
  socketRefusal,
  webSocket,
} from "../build-test/lib.mjs";

async function echoServer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const closed = [];
  server.on("connection", (socket) => {
    socket.on("message", (data, binary) => socket.send(binary ? data : `echo:${data}`));
    socket.on("close", (code) => closed.push(code));
  });
  const url = `ws://127.0.0.1:${server.address().port}/`;
  return { server, url, closed };
}

/** A transport straight into a hub, as one script's port. */
function transportTo(hub, owner, key = {}) {
  let next = 1;
  return {
    key,
    stream(op, args, onEvent) {
      assert.equal(op, "ws");
      hub.open(key, owner, args, onEvent);
      return () => undefined;
    },
    async call(op, args) {
      if (op === "ws.send") return hub.send(key, args.sid, args.data);
      if (op === "ws.close") return hub.close(key, args.sid, args.code, args.reason);
      throw new Error(`unexpected ${op} ${next++}`);
    },
    onPush() {},
  };
}

const until = (check) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > 5000) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });

test("GM.webSocket round-trips text, JSON and bytes and closes cleanly", async () => {
  const { server, url } = await echoServer();
  const hub = socketHub();
  const transport = transportTo(hub, { connect: ["localhost"], pageUrl: "https://a.test/" });
  const got = [];
  let closed;
  const socket = webSocket(
    transport,
    {
      url,
      onopen: () => {
        socket.send("hi");
        socket.send(JSON.stringify({ n: 1 }));
        socket.send(new Uint8Array([1, 2, 3]));
      },
      onmessage: (event) => got.push(event.data),
      onclose: (event) => (closed = event),
    },
    (error) => assert.fail(error),
  );
  assert.equal(socket.readyState, 0);
  await until(() => got.length === 3);
  assert.equal(socket.readyState, 1);
  assert.equal(got[0], "echo:hi");
  assert.deepEqual(JSON.parse(got[1].slice(5)), { n: 1 });
  assert.deepEqual([...new Uint8Array(got[2])], [1, 2, 3]);
  socket.close(1000, "bye");
  await until(() => closed);
  assert.equal(closed.code, 1000);
  assert.equal(socket.readyState, 3);
  assert.equal(hub.count(transport.key), 0);
  server.close();
});

test("GM.webSocket refuses other schemes and hosts outside @connect", async () => {
  const owner = { connect: ["api.test"], pageUrl: "https://a.test/" };
  assert.match(socketRefusal("http://api.test/", owner), /ws: and wss:/);
  assert.match(socketRefusal("file:///etc/passwd", owner), /ws: and wss:/);
  assert.match(socketRefusal("wss://evil.test/", owner), /@connect/);
  assert.equal(socketRefusal("wss://live.api.test/", owner), undefined);
  assert.equal(socketRefusal("wss://a.test/feed", owner), undefined, "its own site");
  assert.equal(socketRefusal("wss://anything.test/", { connect: undefined }), undefined);
  const hub = socketHub();
  const errors = [];
  let closed;
  webSocket(
    transportTo(hub, owner),
    {
      url: "wss://evil.test/",
      onerror: (e) => errors.push(e.error),
      onclose: (e) => (closed = e),
    },
    () => undefined,
  );
  assert.match(errors[0], /@connect/);
  assert.equal(closed.code, 1006);
});

test("GM.webSocket caps sockets per script and closes them all when the script goes", async () => {
  const { server, url, closed } = await echoServer();
  const hub = socketHub();
  const transport = transportTo(hub, { connect: ["127.0.0.1"] });
  let opened = 0;
  const errors = [];
  for (let i = 0; i <= MAX_SOCKETS; i++)
    webSocket(
      transport,
      { url, onopen: () => opened++, onerror: (e) => errors.push(e.error) },
      () => undefined,
    );
  assert.match(errors[0], /at most 8/);
  await until(() => opened === MAX_SOCKETS);
  assert.equal(hub.count(transport.key), MAX_SOCKETS);
  hub.release(transport.key);
  await until(() => closed.length === MAX_SOCKETS);
  assert.ok(closed.every((code) => code === 1000));
  server.close();
});

test("all scripts together hold at most 32 sockets, with a clear message", async () => {
  const { server, url } = await echoServer();
  const hub = socketHub();
  const errors = [];
  let opened = 0;
  const scripts = Array.from({ length: 5 }, () => transportTo(hub, { connect: ["127.0.0.1"] }));
  for (const transport of scripts)
    for (let i = 0; i < 7; i++)
      webSocket(
        transport,
        { url, onopen: () => opened++, onerror: (e) => errors.push(e.error) },
        () => undefined,
      );
  assert.equal(MAX_TOTAL_SOCKETS, 32);
  assert.equal(hub.total(), 32);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /All boosts together may hold at most 32 sockets/);
  await until(() => opened === 32);
  for (const transport of scripts) hub.release(transport.key);
  assert.equal(hub.total(), 0);
  server.close();
});

test("an open socket keeps the service worker awake every 20 s, and stops once all close", async () => {
  assert.equal(KEEP_ALIVE_MS, 20_000);
  const { server, url } = await echoServer();
  let pings = 0;
  const hub = socketHub({ keepAliveMs: 40, keepAlive: () => pings++ });
  const transport = transportTo(hub, { connect: ["127.0.0.1"] });
  let open = false;
  // A quiet socket: nothing is sent or received after it opens.
  webSocket(transport, { url, onopen: () => (open = true) }, () => undefined);
  await until(() => open);
  await until(() => pings >= 3);
  hub.release(transport.key);
  const after = pings;
  await new Promise((done) => setTimeout(done, 200));
  assert.ok(pings <= after + 1, `no pings once every socket closed (${after} then ${pings})`);
  server.close();
});
