import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, saveAbility } from "@browserkit/site-mapper";
import { LibraryActions } from "../dist/library-actions.js";
import { abilityCards, lastActionNote } from "../dist/management-library.js";

// The versions/restore management actions without a browser: real ability files in a temp home.

async function home() {
  const root = await mkdtemp(join(tmpdir(), "aeon-ability-versions-"));
  process.env.BROWSERKIT_HOME = join(root, "browserkit");
  process.env.SITE_TO_API_HOME = join(root, "sites");
  return root;
}

function ability(description) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    description,
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    ways: [{ kind: "api", operation: "search", params: { q: "{{inputs.q}}" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("the Sites API lists versions and restores one", async () => {
  await home();
  const site = join(process.env.SITE_TO_API_HOME, "sites", "example.com");
  await mkdir(site, { recursive: true });
  await writeFile(
    join(site, "model.json"),
    JSON.stringify({
      site: "example.com",
      operations: [],
      pages: [],
      generatedAt: new Date().toISOString(),
    }),
  );
  await saveAbility(ability("first"));
  await saveAbility(ability("second"));
  const actions = new LibraryActions(async () => ({}));
  await actions.execute("list_ability_versions", { site: "example.com", name: "search" });
  const at = lastActionNote().message.split(" ")[0];
  assert.match(at, /^\d{4}-\d{2}-\d{2}T/);

  await actions.execute("restore_ability", { site: "example.com", name: "search", at });
  assert.equal(lastActionNote().ok, true);
  assert.match(lastActionNote().message, /Restored search/);
  assert.equal((await readAbility("example.com", "search")).description, "first");

  const cards = await abilityCards();
  const card = cards.find((item) => item.name === "search");
  assert.equal(card.versions.count, 2);
});
