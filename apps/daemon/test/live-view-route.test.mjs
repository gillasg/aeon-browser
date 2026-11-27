// Live viewers as a daemon feature, over real loopback HTTP: start one through the same request
// browser code sends, push rows and frames with its token, read them back with the token, and
// see every read and push refused without it. Idle viewers close, and all close with the daemon.
import assert from "node:assert/strict";
import test from "node:test";
import { LiveViewHub, handleCoreLive, liveViewCall } from "../dist/live-view-route.js";

const push = (view, body, token = view.token) =>
  fetch(view.pushUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const stateUrl = (view, token) => {
  const base = new URL(view.url);
  base.hash = "";
  base.pathname = "/state";
  if (token) base.searchParams.set("t", token);
  return base.href;
};

test("start, push and read with the token; refuse without it; stop closes the server", async () => {
  const hub = new LiveViewHub();
  try {
    const view = await liveViewCall({ liveView: "start", title: "Prices" }, hub);
    assert.match(view.id, /^[0-9a-f]{8}$/);
    assert.equal(view.title, "Prices");
    assert.ok(view.url.includes(`#t=${view.token}`), "the viewer link carries its read token");
    assert.match(view.pushUrl, /^http:\/\/127\.0\.0\.1:\d+\/push$/);

    assert.equal((await push(view, { rows: [{ site: "A", price: 3 }] })).status, 200);
    assert.equal((await push(view, { frame: { tick: 1 } })).status, 200);
    const read = await fetch(stateUrl(view, view.token));
    assert.equal(read.status, 200);
    const state = await read.json();
    assert.deepEqual(state.rows, [{ site: "A", price: 3 }]);
    assert.deepEqual(state.frames, [{ tick: 1 }]);

    assert.equal((await push(view, { rows: [] }, "")).status, 401, "push without a token");
    assert.equal((await push(view, { rows: [] }, "wrong-token-wrong-token-wrong-to")).status, 401);
    assert.equal((await fetch(stateUrl(view))).status, 401, "read without a token");
    assert.equal((await fetch(stateUrl(view, "nope"))).status, 401, "read with a wrong token");

    const [listed] = await liveViewCall({ liveView: "list" }, hub);
    assert.equal(listed.id, view.id);
    assert.equal(listed.rows, 1);
    assert.equal(listed.frames, 1);

    assert.deepEqual(await liveViewCall({ liveView: "stop", id: view.id }, hub), {
      id: view.id,
      stopped: true,
    });
    await assert.rejects(fetch(stateUrl(view, view.token)), "the server is gone after stop");
    assert.deepEqual(await liveViewCall({ liveView: "list" }, hub), []);
  } finally {
    await hub.closeAll();
  }
});

test("a viewer nobody used for the idle limit closes; closeAll closes the rest", async () => {
  let now = Date.now();
  const hub = new LiveViewHub(2 * 60 * 60_000, () => now);
  const idle = await hub.start({ title: "idle" });
  const busy = await hub.start({ title: "busy" });
  try {
    now += 2 * 60 * 60_000 + 1;
    // The busy one is pushed to "now"; the idle one was last used at start.
    assert.equal((await push(busy, { frame: 1 })).status, 200);
    assert.deepEqual(await hub.sweep(), [idle.id]);
    assert.deepEqual(
      hub.list().map((view) => view.id),
      [busy.id],
    );
    await hub.closeAll();
    assert.deepEqual(hub.list(), []);
    await assert.rejects(fetch(stateUrl(busy, busy.token)));
  } finally {
    await hub.closeAll();
  }
});

test("graft live talks to the hub over the core socket", async () => {
  const hub = new LiveViewHub();
  const sent = [];
  const socket = { send: (text) => sent.push(JSON.parse(text)) };
  try {
    assert.equal(handleCoreLive(socket, { kind: "core.settings", requestId: "x" }, hub), false);
    assert.equal(
      handleCoreLive(
        socket,
        { kind: "core.live", requestId: "r1", liveView: "start", title: "t" },
        hub,
      ),
      true,
    );
    while (!sent.length) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent[0].kind, "core.live.result");
    assert.equal(sent[0].requestId, "r1");
    assert.equal(sent[0].result.title, "t");
    handleCoreLive(socket, { kind: "core.live", requestId: "r2", liveView: "bogus" }, hub);
    while (sent.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(sent[1].error, /UNSUPPORTED/);
  } finally {
    await hub.closeAll();
  }
});
