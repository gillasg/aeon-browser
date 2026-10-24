import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateAeonSettings } from "../dist/settings-migration.js";

test("Aeon's old settings merge into browserkit's home and stay in place", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-settings-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "aeon");
  const home = join(root, "browserkit");
  await mkdir(data, { recursive: true });
  await writeFile(
    join(data, "password-manager.json"),
    JSON.stringify({ provider: "bitwarden", bitwardenSession: "old-session" }),
  );
  await writeFile(
    join(data, "site-rules.json"),
    JSON.stringify({ blocked: ["bank.example", "mail.example"] }),
  );
  const previous = process.env.BROWSERKIT_HOME;
  process.env.BROWSERKIT_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERKIT_HOME;
    else process.env.BROWSERKIT_HOME = previous;
  });

  await migrateAeonSettings(data);

  assert.deepEqual(JSON.parse(await readFile(join(home, "password-manager.json"), "utf8")), {
    provider: "bitwarden",
    bitwardenSession: "old-session",
  });
  assert.deepEqual(JSON.parse(await readFile(join(home, "site-rules.json"), "utf8")), {
    blocked: ["bank.example", "mail.example"],
  });
  // The old copies are left for the user; nothing reads them again.
  assert.ok(await readFile(join(data, "password-manager.json"), "utf8"));
  assert.ok(await readFile(join(data, "site-rules.json"), "utf8"));
});
