// Beacons, metrics and fire-and-forget event posts are the page talking to its own analytics.
// They must not become learned operations, capabilities, or noise in the site's API.
import assert from "node:assert/strict";
import test from "node:test";
import { filterExchanges } from "../dist/index.js";
import { groupExchanges } from "../dist/infer/operations.js";

let counter = 0;
function exchange(overrides) {
  counter += 1;
  return {
    id: `e${counter}`,
    source: "live",
    startedAt: counter,
    method: "POST",
    url: "https://shop.test/api/x",
    resourceType: "fetch",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    responseMime: "application/json",
    ...overrides,
  };
}

function kept(overrides) {
  return filterExchanges([exchange(overrides)]).kept.length;
}

test("the usual beacon and metrics paths are dropped when they answer nothing", () => {
  for (const path of [
    "/collect",
    "/g/collect",
    "/telemetry",
    "/metrics",
    "/beacon",
    "/analytics",
    "/pixel",
    "/event",
    "/events",
    "/track",
    "/log",
    "/api/v1/log",
    "/gen_204",
  ]) {
    assert.equal(
      kept({ url: `https://shop.test${path}`, status: 204, responseBody: "" }),
      0,
      `${path} is telemetry`,
    );
  }
});

test("a beacon that answers a bare acknowledgement is still telemetry", () => {
  assert.equal(
    kept({
      url: "https://shop.test/api/metrics",
      responseBody: '{"status":"ok","received":true,"ok":true}',
    }),
    0,
  );
});

test("a request sent with navigator.sendBeacon is telemetry wherever it goes", () => {
  assert.equal(
    kept({
      url: "https://shop.test/api/session/close",
      status: 200,
      responseBody: "",
      initiator: {
        type: "script",
        stack: [{ url: "https://shop.test/app.js", functionName: "sendBeacon", line: 1 }],
      },
    }),
    0,
  );
});

test("a write with an event-batch body and nothing to answer is telemetry on any path", () => {
  assert.equal(
    kept({
      url: "https://shop.test/api/v2/ingest",
      status: 204,
      responseBody: "",
      requestBody: JSON.stringify({ batch: [{ event: "view", ts: 1 }], session_id: "s" }),
    }),
    0,
  );
});

test("real endpoints that look similar are kept", () => {
  // An /events path that answers with data.
  assert.equal(
    kept({
      method: "GET",
      url: "https://shop.test/api/events",
      responseBody: JSON.stringify([
        { id: 1, title: "Concert", venue: "Hall A", date: "2026-01-01" },
      ]),
    }),
    1,
  );
  // Creating an event returns the event.
  assert.equal(
    kept({
      url: "https://shop.test/api/events",
      responseBody: JSON.stringify({ id: 9, title: "Concert", venue: "Hall A", starts: "2026" }),
    }),
    1,
  );
  // A delete that answers 204 on a resource path is a real write.
  assert.equal(
    kept({
      method: "DELETE",
      url: "https://shop.test/api/items/5",
      status: 204,
      responseBody: "",
    }),
    1,
  );
});

test("beacons that reach grouping by another route never become operations", () => {
  const beacon = exchange({
    url: "https://shop.test/api/collect",
    status: 204,
    responseBody: "",
  });
  const real = exchange({
    method: "GET",
    url: "https://shop.test/api/items",
    responseBody: JSON.stringify([{ id: 1, name: "Widget", price: 12 }]),
  });
  const { groups } = groupExchanges([
    { exchange: beacon, category: "api" },
    { exchange: real, category: "api" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].template, "/api/items");
});
