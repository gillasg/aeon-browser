import assert from "node:assert/strict";
import test from "node:test";
import { buildSiteModel } from "../dist/index.js";
import { buildRequest } from "../dist/runtime/request.js";
import { exchange } from "./shape-exchanges.mjs";

const O = "https://feed.example";
const b64 = (text) => Buffer.from(text).toString("base64");
const op = (model, path) => model.operations.find((o) => o.path === path);

test("a base64 cursor in a next key pairs with the cursor param", async () => {
  const exchanges = [0, 5, 10].map((at) =>
    exchange(`${O}/api/feed${at ? `?cursor=${b64(String(at))}` : ""}`, {
      json: { items: [{ id: at }], nextCursor: b64(String(at + 5)) },
    }),
  );
  const { model } = await buildSiteModel(exchanges, { site: "feed.example" });
  const feed = op(model, "/api/feed");
  assert.equal(feed.pagination.style, "cursor");
  assert.equal(feed.pagination.param, "query:cursor");
  assert.equal(feed.pagination.nextPointer, "/nextCursor");
  // The first page sends no cursor and needs none.
  const { missing, request } = buildRequest(feed, {});
  assert.deepEqual(missing, []);
  assert.equal(new URL(request.url).searchParams.has("cursor"), false);
});

test("offset advancing by the limit, with a total, is offset paging", async () => {
  const exchanges = [0, 20, 40].map((at) =>
    exchange(`${O}/api/list?s=${at}&limit=20`, {
      json: { total: 70, items: Array.from({ length: 20 }, (_, i) => ({ id: at + i })) },
    }),
  );
  const { model } = await buildSiteModel(exchanges, { site: "feed.example" });
  const list = op(model, "/api/list");
  assert.equal(list.pagination.style, "offset");
  assert.equal(list.pagination.param, "query:s");
  assert.equal(list.pagination.totalPointer, "/total");
  const { missing, request } = buildRequest(list, {});
  assert.deepEqual(missing, []);
  assert.equal(new URL(request.url).searchParams.get("s"), "0");
});

test("page numbers are still detected", async () => {
  const exchanges = [1, 2, 3].map((page) =>
    exchange(`${O}/api/search?q=x&page=${page}`, {
      json: { results: [{ id: page }], has_more: true },
    }),
  );
  const { model } = await buildSiteModel(exchanges, { site: "feed.example" });
  assert.equal(op(model, "/api/search").pagination.style, "page");
});
