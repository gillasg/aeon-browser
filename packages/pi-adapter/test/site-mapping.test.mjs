import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installSiteMapping,
  mappingSettled,
  noteVisits,
  visitedUrls,
} from "../dist/site-mapping.js";

test("background mapping is off: visits are not recorded and no model is asked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-mapping-"));
  const home = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = join(root, "registry");
  t.after(async () => {
    process.env.SITE_TO_API_HOME = home;
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, "site-mapping.json");
  let modelAsked = false;
  installSiteMapping(file, async () => {
    modelAsked = true;
    throw new Error("no model in tests");
  });

  const urls = visitedUrls([
    { action: { op: "openTab", url: "https://www.shop.example/search?q=lamp" } },
    { action: { op: "click" }, result: { tab: { url: "https://shop.example/item/1" } } },
    { action: { op: "openTab", url: "https://www.google.com/search?q=x" } },
    { action: { op: "openTab", url: "https://accounts.shop.example/login" } },
  ]);
  assert.equal(urls.length, 4);
  noteVisits("chat-1", urls);
  noteVisits("chat-1", urls);
  noteVisits("chat-2", ["https://shop.example/"]);
  await mappingSettled();
  await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
  assert.equal(modelAsked, false, "no background model runs");
});
