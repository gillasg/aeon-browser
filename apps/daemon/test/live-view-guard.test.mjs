// The viewer's read side over real HTTP: a rebinding Host gets 421, reads need the token, and the
// page keeps the token in the URL fragment so it never reaches the server.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startLiveView } from "../dist/live-view.js";

/** A raw GET with a chosen Host header (fetch will not let a test forge Host). */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      if (res.headers["content-type"]?.includes("event-stream")) {
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body });
      }
    });
    req.on("error", reject);
  });
}

test("a Host that is not this viewer's loopback name and port gets 421 on every path", async () => {
  const view = await startLiveView();
  const port = new URL(view.url).port;
  try {
    for (const path of ["", "state", "events", "push"])
      for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1:1", "127.0.0.1"])
        assert.equal(
          (await get(view.url + path, { host, authorization: `Bearer ${view.token}` })).status,
          421,
          `${host || "(empty)"} /${path}`,
        );
    assert.equal((await get(view.url, { host: `localhost:${port}` })).status, 200);
  } finally {
    await view.close();
  }
});

test("/state and /events need the token by header or ?t=", async () => {
  const view = await startLiveView();
  try {
    view.pushRows([{ secret: 1 }]);
    for (const path of ["state", "events"]) {
      assert.equal((await get(view.url + path)).status, 401, path);
      assert.equal((await get(`${view.url}${path}?t=wrong`)).status, 401, path);
      assert.equal((await get(`${view.url}${path}?t=${view.token}`)).status, 200, path);
      const header = await get(view.url + path, { "x-graft-view-token": view.token });
      assert.equal(header.status, 200, path);
    }
    const unauth = await get(view.url + "state");
    assert.doesNotMatch(unauth.body, /secret/);
  } finally {
    await view.close();
  }
});

test("the page reads the token from the fragment and sends no referrer", async () => {
  const view = await startLiveView();
  try {
    assert.match(view.viewerUrl, /#t=/);
    const page = await get(view.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.match(page.body, /location\.hash/);
    assert.doesNotMatch(page.body, new RegExp(view.token), "the token is not in the page");
  } finally {
    await view.close();
  }
});
