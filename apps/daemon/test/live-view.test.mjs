// The live viewer: loopback only, a token to push, buffered state replayed and live updates
// streamed over Server-Sent Events, tap frames piped in, a clean shutdown.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { pipeTapToLiveView, startLiveView } from "../dist/live-view.js";

/** Reads SSE events from a URL until `count` have arrived. */
function readEvents(url, count) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(url, (res) => {
      assert.match(res.headers["content-type"], /text\/event-stream/);
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
          events.push({ event, data });
          if (events.length === count) {
            req.destroy();
            resolve(events);
          }
        }
      });
    });
    req.on("error", (error) => (error.code === "ECONNRESET" ? undefined : reject(error)));
  });
}

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("the live viewer listens on loopback only and serves a self-contained page", async () => {
  const view = await startLiveView({ title: "Issues <live>" });
  try {
    assert.match(view.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(view.pushUrl, view.url + "push");
    assert.ok(view.token.length >= 24);
    const page = await fetch(view.url);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    assert.match(html, /EventSource\("events\?t="/);
    assert.equal(view.viewerUrl, `${view.url}#t=${view.token}`);
    assert.match(html, /Issues &#60;live&#62;/, "the title is escaped");
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\//, "no external loads");
  } finally {
    await view.close();
  }
});

test("pushing needs the token and a loopback or extension origin", async () => {
  const view = await startLiveView();
  try {
    assert.equal((await post(view.pushUrl, { rows: [{ a: 1 }] })).status, 401);
    assert.equal(
      (await post(view.pushUrl, { rows: [] }, { authorization: "Bearer nope" })).status,
      401,
    );
    const auth = { authorization: `Bearer ${view.token}` };
    assert.equal(
      (await post(view.pushUrl, { rows: [] }, { ...auth, origin: "https://evil.test" })).status,
      403,
    );
    assert.equal((await post(view.pushUrl, { nothing: 1 }, auth)).status, 400);
    const ok = await post(view.pushUrl, { rows: [{ a: 1 }], title: "T" }, auth);
    assert.equal(ok.status, 200);
    const other = await post(
      view.pushUrl,
      { frame: { n: 1 } },
      { "x-graft-view-token": view.token, origin: "chrome-extension://abc" },
    );
    assert.equal(other.status, 200);
    const state = await (
      await fetch(view.url + "state", { headers: { authorization: `Bearer ${view.token}` } })
    ).json();
    assert.equal(state.title, "T");
    assert.deepEqual(state.rows, [{ a: 1 }]);
    assert.deepEqual(state.frames, [{ n: 1 }]);
    assert.equal(typeof state.updatedAt, "number");
  } finally {
    await view.close();
  }
});

test("/events replays the buffered state, then streams rows and tap frames live", async () => {
  const view = await startLiveView({ maxEvents: 2 });
  try {
    view.pushRows([{ id: 1 }]);
    view.pushFrame({ type: "ws", data: "a" });
    const reading = readEvents(`${view.eventsUrl}?t=${view.token}`, 4);
    await new Promise((done) => setTimeout(done, 100));
    let feed;
    const stop = pipeTapToLiveView(view, (onFrame) => {
      feed = onFrame;
      return { unsubscribe: () => (feed = undefined) };
    });
    view.pushRows([{ id: 1 }, { id: 2 }]);
    feed({ type: "ws", data: "b" });
    feed({ type: "ws", data: "c" });
    const events = await reading;
    assert.equal(events[0].event, "snapshot");
    assert.deepEqual(events[0].data.rows, [{ id: 1 }]);
    assert.deepEqual(events[0].data.frames, [{ type: "ws", data: "a" }]);
    assert.equal(events[1].event, "rows");
    assert.equal(events[1].data.rows.length, 2);
    assert.deepEqual(
      events.slice(2).map((e) => e.data.frame.data),
      ["b", "c"],
    );
    assert.deepEqual(
      view.snapshot().frames.map((f) => f.data),
      ["b", "c"],
      "frames are capped at maxEvents",
    );
    stop();
    assert.equal(feed, undefined, "unsubscribed");
  } finally {
    await view.close();
  }
  await assert.rejects(fetch(view.url));
});
