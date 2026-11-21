import assert from "node:assert/strict";
import test from "node:test";
import { SiteWrites } from "../dist/browser-site-writes.js";

const request = { siteMapper: "write", site: "videos.example", operation: "removeFromWatchLater" };
const undo = {
  kind: "ability-undo",
  site: "videos.example",
  operation: "removeFromWatchLater",
  label: "Undo remove from watch later",
};

test("a write that went through carries the rewind the site's opposite action gives", async () => {
  const asked = [];
  const writes = new SiteWrites(async (site, operation) => {
    asked.push([site, operation]);
    return undo;
  });
  await writes.track({ ...request, params: { setVideoId: "a" } }, Promise.resolve({ ok: true }));
  await writes.track({ ...request, params: { setVideoId: "b" } }, Promise.resolve({ ok: true }));
  const [write] = writes.list();
  assert.equal(write.done, 2);
  assert.deepEqual(write.rewind, undo);
  assert.equal(asked.length, 1, "asked once per operation, not once per item");
});

test("a write with nothing to rewind carries no rewind, and a failed lookup does not fail the write", async () => {
  const none = new SiteWrites(async () => undefined);
  await none.track(request, Promise.resolve({}));
  assert.equal("rewind" in none.list()[0], false);
  const broken = new SiteWrites(async () => {
    throw new Error("lookup failed");
  });
  await broken.track(request, Promise.resolve({}));
  assert.equal(broken.list()[0].done, 1);
  assert.equal("rewind" in broken.list()[0], false);
});

test("a write that failed is not rewound", async () => {
  const writes = new SiteWrites(async () => undo);
  await assert.rejects(writes.track(request, Promise.reject(new Error("refused"))));
  assert.equal(writes.list()[0].failed, 1);
  assert.equal("rewind" in writes.list()[0], false);
});

test("without a lookup, writes behave as before", async () => {
  const writes = new SiteWrites();
  await writes.track(request, Promise.resolve({}));
  assert.equal(writes.list()[0].done, 1);
});
