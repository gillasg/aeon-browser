import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

async function load(source) {
  const directory = await mkdtemp(join(tmpdir(), "aeon-orb-site-"));
  const outfile = join(directory, "module.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL(`../src/orb/${source}`, import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

const verbs = await load("orb-verbs.ts");
const changes = await load("page-changes.ts");

test("the orb shows the site's own verbs, not plumbing", () => {
  const chips = verbs.siteVerbs("shop.example", [
    { id: "listOrders" },
    { id: "getMetadata" },
    { id: "removeFromWatchLater", writes: true },
    { id: "trackPrice" },
    { id: "graphql9ab12" },
  ]);
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ["List orders", "Track price", "Remove from watch later"],
  );
  assert.equal(chips[0].run, true);
  assert.equal(chips[2].run, false);
  assert.equal(chips[2].prompt, "Remove from watch later: ");
});

test("the orb caps its chips and keeps reads before writes", () => {
  const chips = verbs.siteVerbs("shop.example", [
    { id: "firstRead" },
    { id: "secondRead" },
    { id: "thirdRead" },
    { id: "fourthRead" },
    { id: "removeItem", writes: true },
  ]);
  assert.equal(chips.length, 4);
  assert.equal(chips.filter((chip) => chip.run).length, 3);
});

test("changed lines ignore clocks and keep what is new", () => {
  const { added, removed } = changes.lineChanges(
    ["Soundcore Q20", "₹2,999", "2 min ago"],
    ["Soundcore Q20", "₹2,499", "1 min ago"],
  );
  assert.deepEqual(added, ["₹2,499"]);
  assert.deepEqual(removed, ["₹2,999"]);
});

test("a changed line shows what it said before", () => {
  assert.equal(changes.previousOf("Price: ₹2,499", ["Price: ₹2,999", "In stock"]), "Price: ₹2,999");
  assert.equal(changes.previousOf("Completely different words", ["Price: ₹2,999"]), undefined);
});
