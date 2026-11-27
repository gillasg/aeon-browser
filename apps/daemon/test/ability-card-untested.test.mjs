import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveAbility } from "@browserkit/site-mapper";
import { abilityCards } from "../dist/management-library.js";

// A way whose tests were run, then edited, is shown as untested on the Sites/Automations card.

async function home() {
  const root = await mkdtemp(join(tmpdir(), "graft-ability-untested-"));
  process.env.BROWSERKIT_HOME = join(root, "browserkit");
  process.env.SITE_TO_API_HOME = join(root, "sites");
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
  return root;
}

function ability(code) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    outputs: { type: "object", properties: { title: { type: "string" } } },
    ways: [{ kind: "script", runtime: "node", code: `void inputs.q; ${code}` }],
    tests: [{ inputs: { q: "tea" }, expect: { title: "tea" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("a changed way is untested on the card, and saving unchanged content is not", async () => {
  await home();
  await saveAbility(ability("return { title: 'tea' };"), { host: {} });
  let card = (await abilityCards()).find((item) => item.name === "search");
  assert.equal(card.untested, undefined);

  await saveAbility(ability("return { title: 'tea' }; // no behaviour change"));
  card = (await abilityCards()).find((item) => item.name === "search");
  assert.equal(card.untested, undefined, "a comment-only edit keeps the pass");

  await saveAbility(ability("return { title: 'coffee' };"));
  card = (await abilityCards()).find((item) => item.name === "search");
  assert.deepEqual(card.untested, ["script"]);
});
