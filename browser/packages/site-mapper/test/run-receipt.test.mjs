// Run 2 of a learned site says how it was served: compiled, how long, with no model, and the one
// line that serves the site to another agent.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAbility, saveAbility } from "../dist/abilities.js";
import { elapsedLabel, mcpCommandForSite, runReceipt } from "../dist/index.js";
import { operationInputSchema } from "../dist/mcp.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "run-receipt-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function ability(ways) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: {},
    ways,
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
}

test("a compiled API run carries its receipt and the command that serves the site", async () => {
  await withHome(async () => {
    await saveAbility(ability([{ kind: "api", operation: "search" }]));
    const run = await runAbility(
      "example.com",
      "search",
      {},
      { host: { call: async () => ({ items: [1] }) } },
    );
    assert.equal(run.via, "api");
    assert.equal(run.compiled, true);
    assert.equal(typeof run.elapsedMs, "number");
    assert.equal(run.mcpCommand, "aeon mcp example.com");
    assert.match(run.receipt, /^\d+(\.\d)?s · no model · API$/);
  });
});

test("a run served by the page is not marked compiled", async () => {
  await withHome(async () => {
    await saveAbility(ability([{ kind: "page", collect: { row: "body", fields: {} } }]));
    const run = await runAbility(
      "example.com",
      "search",
      {},
      { host: { collect: async () => ({ items: [1] }) } },
    );
    assert.equal(run.compiled, false);
    assert.match(run.receipt, /· page$/);
  });
});

test("the receipt helpers", () => {
  assert.equal(mcpCommandForSite("https://www.Example.com/x"), "aeon mcp example.com");
  assert.equal(elapsedLabel(420), "0.4s");
  assert.equal(elapsedLabel(12_400), "12s");
  assert.deepEqual(runReceipt("example.com", "api", 380.4), {
    compiled: true,
    elapsedMs: 380,
    mcpCommand: "aeon mcp example.com",
    receipt: "0.4s · no model · API",
  });
});

test("an MCP tool asks only for what varies: recorded constants are left out", () => {
  const operation = {
    id: "search",
    method: "POST",
    origin: "https://shop.test",
    path: "/api/search",
    kind: "rest",
    role: "read",
    params: [
      { name: "q", in: "query", required: true, schema: { type: "string" } },
      { name: "market", in: "query", required: false, schema: { type: "string" }, constant: "us" },
    ],
    requestBody: {
      mime: "application/json",
      schema: {
        type: "object",
        properties: { term: { type: "string" }, channel: { type: "string" } },
      },
      constants: { channel: "web" },
    },
    samples: [],
    dependencies: [],
    responses: {},
  };
  const schema = operationInputSchema(operation);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["q", "term"]);
});
