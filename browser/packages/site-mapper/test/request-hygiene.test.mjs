// Learning keeps a site's API and nothing around it: challenge plumbing, media manifests, logos
// and beacons never become operations; a slug seen once that names the page becomes a slot; and
// a POST that only reads a list is learned as a read.
import assert from "node:assert/strict";
import test from "node:test";
import { filterExchanges, fromHar } from "../dist/index.js";
import { buildOperation, finalizeNames, groupExchanges } from "../dist/infer/operations.js";

function harEntry(
  method,
  url,
  { type = "Fetch", mime = "application/json", body, post, pageref } = {},
) {
  return {
    _resourceType: type,
    ...(pageref ? { pageref } : {}),
    request: {
      method,
      url,
      headers: [{ name: "referer", value: "https://www.example.org/" }],
      ...(post ? { postData: { mimeType: "application/json", text: post } } : {}),
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: mime }],
      content: { mimeType: mime, ...(body !== undefined ? { text: body } : {}) },
    },
  };
}

function learn(har) {
  const { kept } = filterExchanges(fromHar(har, "test"));
  const operations = groupExchanges(kept).groups.map(buildOperation);
  finalizeNames(operations);
  return operations;
}

test("a capture with challenge, media, logo and beacon noise learns only the real API", () => {
  const operations = learn({
    log: {
      entries: [
        harEntry("POST", "https://www.booking.com/__challenge_h78IRKX/inputs", {
          body: '{"inputs":[1,2,3]}',
          post: '{"id":"x"}',
        }),
        harEntry("GET", "https://video.steamstatic.com/store_trailers/1/dash_av1.mpd?t=1", {
          type: "XHR",
          mime: "application/dash+xml",
          body: "<MPD/>",
        }),
        harEntry("GET", "https://s4.bcbits.com/img/fastly-logo", {
          mime: "image/png",
          body: "",
        }),
        harEntry("POST", "https://www.goodreads.com/book/show/1", { type: "Ping", body: "" }),
        harEntry("GET", "https://www.example.org/api/items?page=1", {
          body: '{"items":[{"id":1,"name":"a"}]}',
        }),
      ],
    },
  });
  assert.equal(operations.length, 1);
  assert.match(JSON.stringify(operations[0]), /api\/items/);
});

test("a slug seen once that names the page's title becomes a title slot", () => {
  const operations = learn({
    log: {
      pages: [{ id: "p1", title: "Dieter Rams - Wikipedia" }],
      entries: [
        harEntry("GET", "https://en.wikipedia.org/api/rest_v1/page/summary/Dieter_Rams", {
          pageref: "p1",
          body: '{"title":"Dieter Rams","extract":"German designer"}',
        }),
      ],
    },
  });
  assert.equal(operations.length, 1);
  const operation = operations[0];
  assert.doesNotMatch(operation.id, /Dieter|Rams/i);
  assert.ok(
    operation.params.some((param) => param.in === "path" && param.name === "title"),
    JSON.stringify(operation.params),
  );
});

test("a POST that only returns a list of results is learned as a read", () => {
  const operations = learn({
    log: {
      entries: [
        harEntry("POST", "https://bandcamp.com/api/discover/1/discover_web", {
          type: "XHR",
          post: '{"category_id":0,"tag_norm_names":[],"slice":"top","size":60}',
          body: '{"results":[{"id":1,"title":"a"},{"id":2,"title":"b"}],"cursor":"x"}',
        }),
      ],
    },
  });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].role, "read");
});

test("a POST whose path names a write stays an action even when it answers a list", () => {
  const operations = learn({
    log: {
      entries: [
        harEntry("POST", "https://shop.example/api/cart/add", {
          type: "XHR",
          post: '{"sku":"a"}',
          body: '{"items":[{"sku":"a"}]}',
        }),
      ],
    },
  });
  assert.equal(operations[0].role, "action");
});
