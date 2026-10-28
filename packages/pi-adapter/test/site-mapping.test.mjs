import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exploreForRoutine,
  installSiteMapping,
  mappingSettled,
  routineSites,
} from "../dist/site-mapping.js";

async function tempMapping(t) {
  const root = await mkdtemp(join(tmpdir(), "aeon-mapping-"));
  const home = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = join(root, "registry");
  t.after(async () => {
    process.env.SITE_TO_API_HOME = home;
    await rm(root, { recursive: true, force: true });
  });
  return join(root, "site-mapping.json");
}

test("a routine on a site with no learned read gets that site explored once", async (t) => {
  const file = await tempMapping(t);
  assert.deepEqual(
    routineSites("Check https://www.shop.example/desk-lamps every hour; ignore google.com"),
    ["shop.example"],
  );
  let asked = 0;
  installSiteMapping(file, async () => {
    asked += 1;
    throw new Error("no model in tests");
  });
  exploreForRoutine("Tell me when shop.example lists a new desk lamp");
  exploreForRoutine("Tell me when shop.example drops the price");
  await mappingSettled();
  assert.equal(asked, 1, "explored once, not again for the second routine");
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.ok(state.hosts["shop.example"].explored);
  assert.match(state.hosts["shop.example"].error, /no model in tests/);
});
