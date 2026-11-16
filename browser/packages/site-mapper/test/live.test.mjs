import assert from "node:assert/strict";
import test from "node:test";
import {
  learnLive,
  loadModel,
  NotProven,
  reversePairs,
  undoLive,
  writeKind,
  writeLive,
} from "../dist/index.js";
import { SiteClient } from "../dist/runtime/site-mapper.js";
import { tempHome } from "./helpers.mjs";

const SITE = "videos.example";
const PAGE = "https://videos.example/playlist?list=WL";

function entry({ method = "POST", path, status = 200, body, response, step, at = 0 }) {
  return {
    startedDateTime: new Date(Date.UTC(2026, 9, 22, 10, 0, at)).toISOString(),
    _resourceType: "fetch",
    ...(step ? { _step: step } : {}),
    request: {
      method,
      url: "https://videos.example" + path,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "referer", value: PAGE },
      ],
      ...(body ? { postData: { mimeType: "application/json", text: JSON.stringify(body) } } : {}),
    },
    response: {
      status,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { mimeType: "application/json", text: JSON.stringify(response) },
    },
  };
}

const listing = entry({
  method: "GET",
  path: "/api/playlist/WL/items",
  response: {
    items: [
      { videoId: "v1", setVideoId: "row-111", title: "First video" },
      { videoId: "v2", setVideoId: "row-222", title: "Second video" },
    ],
  },
  at: 1,
});
const remove = (status = 200, setVideoId = "row-111") =>
  entry({
    path: "/api/playlist/edit",
    status,
    body: { playlistId: "WL", action: "remove", setVideoId },
    response: { status: "ok", removed: setVideoId },
    step: 'click "Remove from Watch later"',
    at: 5,
  });
const har = (...entries) => ({ log: { version: "1.2", entries } });

test("a write the page made is learned, named after its control and proven", async (t) => {
  await tempHome(t);
  const result = await learnLive(SITE, har(listing, remove()));
  const learned = result.learned.find((item) => item.id === "removeFromWatchLater");
  assert.ok(learned, JSON.stringify(result.learned.map((item) => item.id)));
  assert.equal(learned.role, "action");
  assert.equal(learned.kind, "routine");
  assert.equal(learned.proven, true);
  assert.equal(learned.related, true);
  const listed = result.learned.find((item) => item.role === "read");
  assert.ok(listed, JSON.stringify(result.learned));
  assert.equal(listed.related, undefined, "a page-load read is not related to the click");
  assert.equal(learned.step, 'click "Remove from Watch later"');
  assert.match(learned.how, /siteMapper\.write\('videos\.example', 'removeFromWatchLater'/);
  assert.ok(learned.params.includes("setVideoId"));
  const model = await loadModel(SITE);
  const operation = model.operations.find((item) => item.id === "removeFromWatchLater");
  assert.deepEqual(operation.steps, ['click "Remove from Watch later"']);
  // Announced once: the same capture again teaches nothing new.
  const again = await learnLive(SITE, har(remove(200, "row-222")));
  assert.equal(
    again.learned.some((item) => item.id === "removeFromWatchLater"),
    false,
  );
});

test("unproven and consequential writes are refused before anything is sent", async (t) => {
  await tempHome(t);
  await learnLive(SITE, har(listing, remove(500)));
  await assert.rejects(
    writeLive(SITE, "removeFromWatchLater", { setVideoId: "row-222" }),
    (error) => error instanceof NotProven && /not proven yet/.test(error.message),
  );
  const order = entry({
    path: "/api/checkout/place-order",
    body: { cart: "c1" },
    response: { ok: true },
    step: 'click "Place your order"',
    at: 9,
  });
  const learned = (await learnLive(SITE, har(order))).learned[0];
  assert.equal(learned.kind, "consequential");
  assert.equal(learned.proven, undefined);
  await assert.rejects(
    writeLive(SITE, learned.id, { cart: "c1" }),
    (error) => error instanceof NotProven && /approves/.test(error.message),
  );
});

test("a proven routine write goes to the site's tab", async (t) => {
  await tempHome(t);
  await learnLive(SITE, har(listing, remove()));
  // No browser in the test: getting as far as the page transport means it was allowed.
  await assert.rejects(
    writeLive(SITE, "removeFromWatchLater", { setVideoId: "row-222" }),
    (error) => !(error instanceof NotProven),
  );
});

test("unclear writes count as consequential", () => {
  const operation = (id, steps = []) => ({ id, steps, path: "/api/x", method: "POST" });
  assert.equal(writeKind(operation("markAsRead", ['click "Mark as read"'])), "routine");
  assert.equal(writeKind(operation("sendMessage", ['click "Send"'])), "consequential");
  assert.equal(writeKind(operation("doThing", ['click "Go"'])), "consequential");
  assert.equal(writeKind(operation("removeItem"), ["removeItem"]), "consequential");
});

test("a routine write is paired with its learned opposite for Undo", () => {
  const operation = (id) => ({ id, role: "action", method: "POST", path: "/api/playlist/edit" });
  const pairs = reversePairs([
    operation("removeFromWatchLater"),
    operation("addToWatchLater"),
    operation("listPlaylist"),
  ]);
  assert.equal(pairs.removeFromWatchLater, "addToWatchLater");
  assert.equal(pairs.addToWatchLater, "removeFromWatchLater");
  assert.equal(pairs.listPlaylist, undefined);
});

test("Undo refuses a write the API never made", async (t) => {
  await tempHome(t);
  await learnLive(SITE, har(listing, remove(500)));
  await assert.rejects(
    undoLive(SITE, "removeFromWatchLater", { setVideoId: "row-111" }),
    (error) => error instanceof NotProven && /nothing to undo/.test(error.message),
  );
});

test("a search XHR that answers HTML is learned as a search operation", async (t) => {
  await tempHome(t);
  const search = {
    startedDateTime: new Date(Date.UTC(2026, 9, 22, 10, 0, 3)).toISOString(),
    _resourceType: "xhr",
    _step: 'fill "Search domains"',
    request: {
      method: "GET",
      url: "https://domains.example/domains/search?q=lamp",
      headers: [{ name: "accept", value: "text/html" }],
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "text/html" }],
      content: {
        mimeType: "text/html",
        text: "<ul><li>lamp.com</li><li>lamp.co</li></ul>",
      },
    },
  };
  const result = await learnLive("domains.example", har(search));
  const model = await loadModel("domains.example");
  const operation = model.operations.find((item) => item.capabilities?.includes("search"));
  assert.ok(operation, JSON.stringify(model.operations.map((item) => item.id)));
  assert.match(operation.path, /^\/domains\/search/);
  assert.equal(operation.method, "GET");
  assert.equal(operation.role, "read");
  assert.ok(operation.params.some((param) => param.name === "q"));
  assert.ok(
    result.learned.some((item) => item.id === operation.id),
    "the new search operation is announced",
  );
});

function limitModel(site) {
  const operation = (id, role, method) => ({
    id,
    method,
    origin: `https://${site}`,
    path: "/" + id,
    kind: "rest",
    params: [],
    responses: {},
    role,
    security: [],
    dependencies: [],
    confidence: 1,
    bucket: "high",
    flags: [],
    sampleCount: 0,
    sources: [],
    pageUrls: [],
    samples: [],
  });
  return {
    version: 1,
    site,
    title: site,
    generatedAt: "2026-11-16T00:00:00.000Z",
    origins: [`https://${site}`],
    security: [],
    operations: [operation("load", "read", "GET"), operation("save", "action", "POST")],
    pages: [],
    channels: [],
    components: {},
    noise: [],
    stats: { exchanges: 0, kept: 0, captures: [] },
  };
}

/** Plays scripted answers. `sent` counts how many times the site was contacted. */
function scripted(site, responses) {
  let sent = 0;
  const send = async () => {
    const response = responses[Math.min(sent, responses.length - 1)];
    sent += 1;
    return response;
  };
  return {
    sent: () => sent,
    client: new SiteClient(limitModel(site), {
      transport: "direct",
      transports: {
        direct: { name: "direct", send },
        page: { name: "page", send },
      },
    }),
  };
}

test("a 418 or 420 that names a rate limit is retried on a read and sent once on a write", async () => {
  const read = scripted("limit-418.test", [
    { status: 418, headers: { "retry-after": "0" }, text: "teapot" },
    { status: 200, headers: {}, json: { items: [1] } },
  ]);
  assert.deepEqual(await read.client.call("load"), { items: [1] });
  assert.equal(read.sent(), 2);

  const words = scripted("limit-420.test", [
    { status: 420, headers: { "retry-after": "0" }, text: "too many requests" },
    { status: 200, headers: {}, json: { items: [2] } },
  ]);
  assert.deepEqual(await words.client.call("load"), { items: [2] });
  assert.equal(words.sent(), 2);

  const body = scripted("limit-json.test", [
    {
      status: 200,
      headers: { "retry-after": "0" },
      json: { error: { code: 429 } },
      text: '{"error":{"code":429}}',
    },
    { status: 200, headers: {}, json: { items: [3] } },
  ]);
  assert.deepEqual(await body.client.call("load"), { items: [3] });
  assert.equal(body.sent(), 2);
});

test("a 2xx body that is only a 429 is not returned as data", async () => {
  const stuck = scripted("limit-stuck.test", [
    {
      status: 200,
      headers: { "retry-after": "0" },
      json: { error: { code: 429 } },
      text: '{"error":{"code":429}}',
    },
  ]);
  await assert.rejects(stuck.client.call("load"), /RATE_LIMITED/);
  assert.ok(stuck.sent() > 1);
});

test("a write is not retried when the answer is a rate limit", async () => {
  const write = scripted("limit-write.test", [
    { status: 418, headers: { "retry-after": "0" }, text: "rate limit" },
    { status: 200, headers: {}, json: { ok: true } },
  ]);
  const response = await write.client.write("save", {});
  assert.equal(response.status, 418);
  assert.equal(write.sent(), 1);
});

test("a 2xx body that has data beside a 429 is the site's answer", async () => {
  const mixed = scripted("limit-mixed.test", [
    { status: 200, headers: {}, json: { items: [1], error: { code: 429 } } },
  ]);
  assert.deepEqual(await mixed.client.call("load"), { items: [1], error: { code: 429 } });
  assert.equal(mixed.sent(), 1);
});

test("a plain 418 is not a rate limit", async () => {
  const plain = scripted("limit-plain.test", [
    { status: 418, headers: {}, text: "I am a teapot" },
    { status: 200, headers: {}, json: { items: [9] } },
  ]);
  await assert.rejects(plain.client.call("load"), /HTTP 418/);
  assert.equal(plain.sent(), 1);
});
