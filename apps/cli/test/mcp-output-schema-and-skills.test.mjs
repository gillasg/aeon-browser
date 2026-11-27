import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSiteModel,
  compileSiteOps,
  parseCapture,
  saveModel,
} from "@browserkit/tools/site-to-api";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ITEM = { items: [{ id: 1, name: "lamp", price: 40 }], total: 1 };
const TAGS = [{ tag: "home" }, { tag: "light" }];

function har(origin) {
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
      creator: { name: "graft-test", version: "1" },
      entries: [entry("/api/items?q=lamp", ITEM), entry("/api/tags", TAGS)],
    },
  });
}

function startSite() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url.startsWith("/api/tags") ? TAGS : ITEM));
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

function mcp(home) {
  const child = spawn(process.execPath, [cli, "mcp", "--surface", "full"], {
    env: {
      ...process.env,
      GRAFT_DATA_DIR: join(home, "data"),
      SITE_TO_API_HOME: join(home, "site-to-api"),
      GRAFT_CATALOG_POLL_MS: "100",
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

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

test("graft mcp: outputSchema + structuredContent on mapped ops, skills as resources", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "graft-mcp-skills-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  process.env.SITE_TO_API_HOME = join(home, "site-to-api");
  const { model } = await buildSiteModel(parseCapture(har(site.origin), "flow"), {
    site: "127.0.0.1",
  });
  await saveModel(model);
  await compileSiteOps("127.0.0.1");
  const client = mcp(home);
  t.after(() => client.close());

  const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.capabilities.resources.listChanged, true);

  const tools = (await client.request("tools/list")).result.tools;
  const core = tools.filter((tool) => !tool.name.startsWith("site__"));
  assert.ok(core.every((tool) => tool.outputSchema === undefined));
  const mapped = tools.filter((tool) => tool.name.startsWith("site__") && tool.outputSchema);
  assert.equal(mapped.length, 2, tools.map((tool) => tool.name).join(", "));
  for (const tool of mapped) {
    assert.equal(tool.outputSchema.type, "object");
    const called = await client.request("tools/call", {
      name: tool.name,
      arguments: tool.inputSchema.properties?.q ? { q: "lamp" } : {},
    });
    assert.equal(called.result.isError, false, called.result.content?.[0]?.text);
    const value = JSON.parse(called.result.content[0].text);
    const structured = called.result.structuredContent;
    if (Array.isArray(value)) {
      assert.ok(tool.outputSchema.properties.items, "an array answer is wrapped as items");
      assert.deepEqual(structured, { items: value });
    } else assert.deepEqual(structured, value);
    for (const key of tool.outputSchema.required ?? []) assert.ok(key in structured, key);
  }

  const listed = (await client.request("resources/list")).result.resources;
  assert.equal(listed.length, 1);
  const [skill] = listed;
  assert.equal(skill.uri, "graft://skills/127.0.0.1");
  assert.equal(skill.mimeType, "text/markdown");
  assert.match(skill._meta.version, /^[0-9a-f]{12}$/);
  const again = (await client.request("resources/list")).result.resources[0];
  assert.equal(again._meta.version, skill._meta.version, "version is deterministic");

  const skillPath = join(home, "site-to-api", "sites", "127.0.0.1", "SKILL.md");
  const read = await client.request("resources/read", { uri: skill.uri });
  assert.equal(read.result.contents[0].text, await readFile(skillPath, "utf8"));
  assert.equal(read.result.contents[0]._meta.version, skill._meta.version);

  for (const uri of [
    "graft://skills/../../etc/passwd",
    "graft://skills/a/b",
    "graft://skills/x\\y",
  ]) {
    const bad = await client.request("resources/read", { uri });
    assert.equal(bad.error?.code, -32602, uri);
  }
  const missing = await client.request("resources/read", { uri: "graft://skills/nope.example" });
  assert.equal(missing.error?.code, -32602);

  await writeFile(skillPath, (await readFile(skillPath, "utf8")) + "\nhealed\n");
  assert.ok(
    await until(() =>
      client.notes.some(
        (note) =>
          note.method === "notifications/resources/updated" && note.params?.uri === skill.uri,
      ),
    ),
    "a changed skill sends notifications/resources/updated",
  );
  const after = (await client.request("resources/list")).result.resources[0];
  assert.notEqual(after._meta.version, skill._meta.version);
});
