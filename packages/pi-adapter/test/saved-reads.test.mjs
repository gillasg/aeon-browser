import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getSavedRead, putSavedRead, readKey, readLines } from "../dist/saved-reads.js";

test("a page key drops the fragment and tracking parameters", () => {
  assert.equal(
    readKey("https://example.com/p?utm_source=x&id=2&fbclid=y#part"),
    "https://example.com/p?id=2",
  );
  assert.equal(
    readKey("aeon-api://shop.example/list?%5B%5D"),
    "aeon-api://shop.example/list?%5B%5D",
  );
});

test("a read keeps its lines, trimmed and bounded", () => {
  const lines = readLines("  One  \n\n\n22\n" + "x".repeat(400));
  assert.deepEqual(lines.slice(0, 2), ["One", "22"]);
  assert.equal(lines[2].length, 300);
});

test("only pages Aeon has read are kept and updated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    await putSavedRead(root, "https://shop.example/item", "₹2,999", { onlyIfKnown: true }),
    false,
  );
  assert.equal(await putSavedRead(root, "https://shop.example/item", "₹2,999\nIn stock"), true);
  const saved = await getSavedRead(root, "https://shop.example/item");
  assert.deepEqual(saved?.lines, ["₹2,999", "In stock"]);
  assert.equal(
    await putSavedRead(root, "https://shop.example/item", "₹2,799", { onlyIfKnown: true }),
    true,
  );
  assert.deepEqual((await getSavedRead(root, "https://shop.example/item"))?.lines, ["₹2,799"]);
});
