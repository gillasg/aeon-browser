import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyBlockedSites } from "../dist/blocked-sites-settings.js";

test("the daemon keeps one blocked list and merges the extension's old one once", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-blocked-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.BROWSERKIT_HOME;
  process.env.BROWSERKIT_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERKIT_HOME;
    else process.env.BROWSERKIT_HOME = previous;
  });

  assert.deepEqual(await applyBlockedSites({ action: "read" }), []);
  assert.deepEqual(
    await applyBlockedSites({ action: "read", local: ["www.bank.example", "mail.example"] }),
    ["bank.example", "mail.example"],
  );
  assert.deepEqual(await applyBlockedSites({ action: "add", site: "https://shop.example/path" }), [
    "bank.example",
    "mail.example",
    "shop.example",
  ]);
  assert.deepEqual(await applyBlockedSites({ action: "remove", site: "mail.example" }), [
    "bank.example",
    "shop.example",
  ]);
  await assert.rejects(
    () => applyBlockedSites({ action: "add", site: "not a site" }),
    /Not a site/,
  );
});
