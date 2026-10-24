import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exploreForRoutine,
  installSiteMapping,
  mappingSettled,
  routineSites,
  noteVisits,
  visitedUrls,
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

const oversized =
  "RESULT_TOO_LARGE: the result was 8.7 MB. Return less, or write it with artifact(name, data) and return a summary.";

test("one chat's visit is tracked but does not explore the site", async (t) => {
  const file = await tempMapping(t);
  let asked = 0;
  installSiteMapping(file, async () => {
    asked += 1;
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
  await mappingSettled();

  assert.equal(asked, 0, "a site used in one chat is not explored");
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(state.hosts["shop.example"].chats, ["chat-1"]);
  assert.equal(state.hosts["shop.example"].explored, undefined);
  assert.equal(state.hosts["google.com"], undefined, "search engines are skipped");
  assert.equal(state.hosts["accounts.shop.example"], undefined, "sign-in hosts are skipped");
});

test("a site used in two chats is explored once; a failure keeps a short reason and retries after a week", async (t) => {
  const file = await tempMapping(t);
  let asked = 0;
  installSiteMapping(file, async () => {
    asked += 1;
    throw new Error(oversized);
  });

  noteVisits("chat-1", ["https://shop.example/"]);
  await mappingSettled();
  assert.equal(asked, 0);

  noteVisits("chat-2", ["https://shop.example/item/1"]);
  await mappingSettled();
  assert.equal(asked, 1, "the second chat starts the explore");
  let state = JSON.parse(await readFile(file, "utf8"));
  assert.match(state.hosts["shop.example"].error, /^RESULT_TOO_LARGE/);
  assert.ok(state.hosts["shop.example"].error.length <= 200, "the reason stays short");
  assert.ok(state.hosts["shop.example"].explored, "the attempt is remembered");

  noteVisits("chat-2", ["https://shop.example/item/2"]);
  await mappingSettled();
  assert.equal(asked, 1, "it waits out the week instead of retrying at once");

  state.hosts["shop.example"].explored = Date.now() - 8 * 86_400_000;
  await writeFile(file, JSON.stringify(state));
  noteVisits("chat-1", ["https://shop.example/item/3"]);
  await mappingSettled();
  assert.equal(asked, 2, "a failed explore is tried again after a week");
});

test("older state that tracked a host in two chats is explored on install", async (t) => {
  const file = await tempMapping(t);
  await writeFile(
    file,
    JSON.stringify({
      hosts: {
        "letterboxd.com": { chats: ["chat-1", "chat-2", "chat-3"] },
        "nfl.com": { chats: ["chat-1"] },
      },
      explores: [],
      repairs: { "letterboxd.com:filmPage": Date.now() },
    }),
  );
  let asked = 0;
  installSiteMapping(file, async () => {
    asked += 1;
    throw new Error("no model in tests");
  });
  await mappingSettled();

  assert.equal(asked, 1, "only the host used in two or more chats is explored");
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.match(state.hosts["letterboxd.com"].error, /no model in tests/);
  assert.equal(state.hosts["nfl.com"].explored, undefined);
});

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
