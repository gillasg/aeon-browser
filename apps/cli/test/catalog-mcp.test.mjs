import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSiteModel, parseCapture, saveModel } from "@browserkit/tools/site-to-api";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function itemsHar(origin) {
  const entry = (path, body) => ({
    startedDateTime: new Date().toISOString(),
    _resourceType: "xhr",
    request: {
      method: "GET",
      url: `${origin}${path}`,
      headers: [{ name: "accept", value: "application/json" }],
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { mimeType: "application/json", text: JSON.stringify(body) },
    },
  });
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "aeon-test", version: "1" },
      entries: [entry("/api/items?q=lamp", { items: [{ id: 1, name: "lamp", price: 40 }] })],
    },
  });
}

function startSite() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ id: 1, name: "lamp", price: 40 }] }));
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

function mcp(home) {
  const child = spawn(process.execPath, [cli, "mcp"], {
    env: {
      ...process.env,
      AEON_DATA_DIR: join(home, "data"),
      SITE_TO_API_HOME: join(home, "site-to-api"),
      AEON_CATALOG_POLL_MS: "200",
    },
  });
  let buffer = "";
  const waiting = new Map();
  const notes = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (message.id === undefined) notes.push(message);
      else waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  return {
    notes,
    request: (method, params = {}) =>
      new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out ${method}`)), 15000);
        waiting.set(++id, (message) => {
          clearTimeout(timer);
          done(message);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    close: () => child.kill(),
  };
}

test("aeon mcp lists a fixture operation, calls it, and notices a catalog change", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-catalog-mcp-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  process.env.SITE_TO_API_HOME = join(home, "site-to-api");
  const { model } = await buildSiteModel(parseCapture(itemsHar(site.origin), "flow"), {
    site: "127.0.0.1",
  });
  await saveModel(model);
  const operation = model.operations[0];
  assert.ok(operation, "the fixture produced an operation");
  const abilityDir = join(home, "site-to-api", "sites", "127.0.0.1", "abilities");
  await mkdir(abilityDir, { recursive: true });
  await writeFile(
    join(abilityDir, "list-saved.json"),
    JSON.stringify({
      name: "listSaved",
      site: "127.0.0.1",
      description: "Saved list of lamps",
      kind: "read",
      inputs: { type: "object", properties: {} },
      ways: [{ kind: "api", operation: operation.id }],
      options: {},
      stats: { runs: 0, failures: 0 },
      createdBy: "user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const client = mcp(home);
  t.after(() => client.close());
  const initialized = await client.request("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.capabilities.tools.listChanged, true);
  const listed = await client.request("tools/list");
  const tools = listed.result.tools;
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("catalog_search"));
  const opTool = tools.find((tool) => tool.name === `site__127_0_0_1__${operation.id}`);
  assert.ok(opTool, names.filter((name) => name.startsWith("site__")).join(", "));
  assert.equal(opTool.annotations.readOnlyHint, true);
  assert.equal(opTool.annotations.destructiveHint, false);
  assert.match(opTool.description, /Returns the operation/);
  const ability = tools.find((tool) => tool.name === "site__127_0_0_1__listSaved");
  assert.ok(ability);
  assert.match(ability.description, /Returns \{result, via\}/);
  const called = await client.request("tools/call", {
    name: opTool.name,
    arguments: { q: "lamp" },
  });
  assert.equal(called.result.isError, false, called.result.content?.[0]?.text);
  const body = JSON.parse(called.result.content[0].text);
  assert.equal(body.items[0].name, "lamp");
  const found = await client.request("tools/call", {
    name: "catalog_search",
    arguments: { query: "lamps" },
  });
  const matches = JSON.parse(found.result.content[0].text);
  assert.ok(matches.some((tool) => tool.name === ability.name));
  await writeFile(
    join(abilityDir, "extra.json"),
    JSON.stringify({
      name: "extraLamps",
      site: "127.0.0.1",
      description: "Another lamp list",
      kind: "read",
      inputs: { type: "object", properties: {} },
      ways: [{ kind: "api", operation: operation.id }],
      options: {},
      stats: { runs: 0, failures: 0 },
      createdBy: "user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  for (
    let i = 0;
    i < 40 && !client.notes.some((note) => note.method === "notifications/tools/list_changed");
    i += 1
  )
    await new Promise((done) => setTimeout(done, 50));
  assert.ok(
    client.notes.some((note) => note.method === "notifications/tools/list_changed"),
    "catalog changes send tools/list_changed",
  );
});

test("automation help documents browser and webhook", async () => {
  const child = spawn(process.execPath, [cli, "automation", "--help"], { env: process.env });
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  const code = await new Promise((done) => child.on("close", done));
  assert.equal(code, 0);
  assert.match(text, /--browser/);
  assert.match(text, /--webhook/);
  assert.match(text, /--webhook-only/);
});
