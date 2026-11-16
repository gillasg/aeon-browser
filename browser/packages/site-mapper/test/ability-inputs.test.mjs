import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAbility, saveAbility } from "../dist/abilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-inputs-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function ability() {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: {
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "number" } },
    },
    ways: [
      {
        kind: "api",
        operation: "search",
        params: { q: "{{inputs.q}}", limit: "{{inputs.limit}}" },
      },
    ],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("an input the ability does not declare is rejected and the declared names are listed", async () => {
  await withHome(async () => {
    await saveAbility(ability());
    const host = { call: async () => ({ items: [{ id: "a" }] }) };
    await assert.rejects(runAbility("example.com", "search", { lmit: 2 }, { host }), (error) => {
      assert.match(error.message, /Unknown input "lmit"/);
      assert.match(error.message, /Declared: q, limit/);
      assert.match(error.message, /Did you mean "limit"/);
      return true;
    });
    const run = await runAbility("example.com", "search", { q: "tea", limit: 2 }, { host });
    assert.equal(run.via, "api");
  });
});
