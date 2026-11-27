import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { storeManifest, zipFiles } from "./package-cws.mjs";
import {
  REPO_ROOT,
  diffLock,
  listingErrors,
  listingSummary,
  packagingErrors,
  runStoreLock,
} from "./store-lock.mjs";

const lock = {
  $comment: "test",
  permissions: ["storage", "tabs"],
  optional_permissions: ["history"],
  host_permissions: ["https://*/*"],
  content_scripts: [{ matches: ["https://*/*"], js: ["a.js"] }],
  web_accessible_resources: [{ resources: ["a.html"], matches: ["https://*/*"] }],
};
const manifest = { name: "x", key: "secret", ...structuredClone(lock) };
delete manifest.$comment;
const listing = [
  "## Summary",
  "",
  "Short summary.",
  "### `storage`",
  "### `tabs`",
  "### `history`",
  "### `https://*/*`",
].join("\n");

test("a manifest matching the lock passes", () => {
  assert.deepEqual(diffLock(manifest, lock), []);
});

test("an added or a removed permission fails", () => {
  const added = { ...manifest, permissions: ["storage", "tabs", "cookies"] };
  const removed = { ...manifest, optional_permissions: [] };
  assert.match(diffLock(added, lock)[0], /^permissions differs/);
  assert.match(diffLock(removed, lock)[0], /^optional_permissions differs/);
});

test("changed content scripts or resources fail", () => {
  const changed = { ...manifest, content_scripts: [], web_accessible_resources: undefined };
  assert.equal(diffLock(changed, lock).length, 2);
});

test("an unknown lock field fails", () => {
  assert.match(diffLock(manifest, { ...lock, extra: [] })[0], /unknown field: extra/);
});

test("the listing must explain every locked permission", () => {
  assert.deepEqual(listingErrors(listing, lock), []);
  const missing = listingErrors(listing.replace("### `history`", ""), lock);
  assert.deepEqual(missing, ["store/listing.md has no justification for history"]);
});

test("the listing summary must exist and fit 132 characters", () => {
  assert.equal(listingSummary(listing), "Short summary.");
  const long = listing.replace("Short summary.", "a".repeat(133));
  assert.match(listingErrors(long, lock)[0], /133 characters/);
  assert.match(listingErrors("### `storage`", lock).at(-1), /no summary/);
});

test("the store package drops only the key", () => {
  assert.deepEqual(packagingErrors(manifest), []);
  assert.equal("key" in storeManifest(manifest), false);
  assert.equal(storeManifest(manifest).name, "x");
});

test("the zip writer stores files that read back unchanged", () => {
  const data = Buffer.from('{"name":"x"}\n');
  const zip = zipFiles([{ name: "manifest.json", data }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nameLength = zip.readUInt16LE(26);
  const packedSize = zip.readUInt32LE(18);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), "manifest.json");
  const start = 30 + nameLength;
  assert.deepEqual(inflateRawSync(zip.subarray(start, start + packedSize)), data);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});

test("the repo's manifest, lock and listing agree", () => {
  assert.deepEqual(runStoreLock(REPO_ROOT), []);
  const real = JSON.parse(readFileSync(join(REPO_ROOT, "store/permissions.json"), "utf8"));
  assert.ok(real.permissions.includes("debugger"));
});
