// The command line: browserkit's commands are all here, with their help and exit codes, plus
// real paths for a mapped site (direct transport, REST and MCP) and a plain-HTTP page read.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "browserkit/dist/commands/index.js";
import { buildSiteModel, parseCapture, saveModel } from "@browserkit/tools/site-to-api";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function aeon(home, args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        AEON_DATA_DIR: join(home, "data"),
        SITE_TO_API_HOME: join(home, "site-to-api"),
      },
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/** A HAR with two XHRs that answer JSON: the smallest thing a site's API can be built from. */
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
      entries: [
        entry("/api/items?q=lamp", { items: [{ id: 1, name: "lamp", price: 40 }] }),
        entry("/api/items/7", { id: 7, name: "shade", price: 20 }),
        entry("/api/items/9", { id: 9, name: "bulb", price: 5 }),
      ],
    },
  });
}

function startSite() {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/items")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ id: 1, name: "lamp", price: 40 }] }));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<title>Shop</title><h1>Shop</h1><p>Lamps and shades.</p>");
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

async function mapped(home, origin) {
  process.env.SITE_TO_API_HOME = join(home, "site-to-api");
  const { model } = await buildSiteModel(parseCapture(itemsHar(origin), "flow"), {
    site: "127.0.0.1",
  });
  await saveModel(model);
  delete process.env.SITE_TO_API_HOME;
  return model;
}

test("every browserkit command has an aeon command", async () => {
  const commands = await run(process.execPath, [cli, "--help"]).then(({ stdout }) => stdout);
  for (const command of COMMANDS)
    assert.match(commands, new RegExp(`\\b${command.name}\\b`), `${command.name} is missing`);
});

test("help groups commands like browserkit, and every command has its own help", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-cli-"));
  try {
    const usage = await aeon(home, ["--help"]);
    assert.equal(usage.code, 0, usage.stderr);
    for (const group of [
      "Aeon",
      "Browser",
      "Read the web",
      "Map a site",
      "Use a site",
      "Keep a site working",
      "Blocked sites",
      "Sign in",
      "Change sites",
    ])
      assert.match(usage.stdout, new RegExp(`^${group}$`, "m"), `${group} in the help`);
    const single = await aeon(home, ["call", "--help"]);
    assert.equal(single.code, 0);
    assert.match(single.stdout, /Usage: aeon call/);
    const unknown = await aeon(home, ["nonsense"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stdout, /aeon <command>/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a mapped site is callable over direct transport, and its operations are listed", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-call-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  const model = await mapped(home, site.origin);
  const operation = model.operations.find((item) => item.path === "/api/items");
  assert.ok(operation, model.operations.map((item) => item.path).join(", "));

  const called = await aeon(home, [
    "call",
    "127.0.0.1",
    operation.id,
    '{"q":"lamp"}',
    "--transport",
    "direct",
  ]);
  assert.equal(called.code, 0, called.stderr);
  assert.equal(JSON.parse(called.stdout).items[0].name, "lamp");

  const ops = await aeon(home, ["ops", "127.0.0.1", "--json"]);
  assert.equal(ops.code, 0, ops.stderr);
  const listed = JSON.parse(ops.stdout).operations.find((item) => item.id === operation.id);
  assert.ok(Array.isArray(listed.capabilities), JSON.stringify(listed));

  const sites = await aeon(home, ["sites", "--json"]);
  assert.equal(sites.code, 0, sites.stderr);
  assert.equal(JSON.parse(sites.stdout)[0].site, "127.0.0.1");

  // A path input nothing produces cannot be filled in: exit code 2, not a generic failure.
  const detail = model.operations.find((item) => item.path.includes("{"));
  if (detail) {
    const missing = await aeon(home, ["call", "127.0.0.1", detail.id, "--transport", "direct"]);
    assert.equal(missing.code, 2, missing.stderr);
    assert.match(missing.stderr, /needs:/);
  }
});

test("export and diff work on a mapped site without a browser", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-export-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  await mapped(home, site.origin);
  const out = join(home, "api");
  const exported = await aeon(home, ["export", "127.0.0.1", "--out", out]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.match(exported.stdout, /Exported to/);
  const diff = await aeon(home, ["diff", "127.0.0.1", "--json"]);
  assert.equal(diff.code, 0, diff.stderr);
});

test("crawl reads a page over plain HTTP", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-crawl-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  const result = await aeon(home, [
    "scrape",
    site.origin,
    "--formats",
    "text",
    "--render",
    "static",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.status, 200);
  assert.match(page.text, /Lamps and shades/);

  const scraped = await aeon(home, [
    "crawl",
    "scrape",
    site.origin,
    "--formats",
    "markdown",
    "--render",
    "static",
    "--json",
  ]);
  assert.equal(scraped.code, 0, scraped.stderr);
  assert.match(JSON.parse(scraped.stdout).markdown, /# Shop/);
});

test("blocked sites say Aeon is not running, and a non-site is refused before that", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-block-"));
  try {
    const refused = await aeon(home, ["block", "not a site"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Not a site/);
    const usage = await aeon(home, ["unblock"]);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /Usage: aeon unblock/);
    const blocked = await aeon(home, ["blocked"]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /Aeon is not running/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the journal keeps what this command line ran", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-journal-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "data"), { recursive: true });
    await writeFile(
      join(home, "data", "cli-journal.jsonl"),
      JSON.stringify({
        ts: "2026-10-24T00:00:00.000Z",
        session: "cli",
        isError: false,
        durationMs: 12,
        resultPreview: "ok",
      }) + "\n",
    );
    const listed = await aeon(home, ["journal", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].resultPreview, "ok");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("mcp serves one mapped site as its own tools", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-mcp-site-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  const model = await mapped(home, site.origin);
  const replies = await mcp(
    home,
    ["127.0.0.1"],
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
  );
  assert.match(replies[0].result.serverInfo.name, /127\.0\.0\.1/);
  const names = replies[1].result.tools.map((tool) => tool.name);
  assert.ok(
    names.some((name) => name.includes(model.operations[0].id.replace(/[^A-Za-z0-9_-]/g, "_"))),
    names.join(", "),
  );
});

test("rest serves one mapped site with docs and a token", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-rest-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  const model = await mapped(home, site.origin);
  const child = spawn(process.execPath, [cli, "rest", "127.0.0.1"], {
    env: {
      ...process.env,
      AEON_DATA_DIR: join(home, "data"),
      SITE_TO_API_HOME: join(home, "site-to-api"),
    },
  });
  t.after(() => child.kill());
  const { url, token } = await banner(child);
  const docs = await (await fetch(`${url}/sites/127.0.0.1/docs`)).text();
  assert.match(docs, /<title>/);
  const operation = model.operations.find((item) => item.path === "/api/items");
  const answer = await (
    await fetch(`${url}/sites/127.0.0.1/ops/${operation.id}`, {
      method: "POST",
      headers: { "x-site-to-api-token": token, "content-type": "application/json" },
      body: JSON.stringify({ q: "lamp" }),
    })
  ).json();
  assert.equal(answer.items[0].name, "lamp");
});

function mcp(home, args, messages) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "mcp", ...args], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        AEON_DATA_DIR: join(home, "data"),
        SITE_TO_API_HOME: join(home, "site-to-api"),
      },
    });
    let buffer = "";
    const replies = [];
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        if (replies.length === messages.length) {
          child.kill();
          resolvePromise(replies);
        }
      }
    });
    child.on("error", reject);
    for (const message of messages) child.stdin.write(JSON.stringify(message) + "\n");
  });
}

function banner(child) {
  return new Promise((resolvePromise, reject) => {
    let text = "";
    const onData = (chunk) => {
      text += chunk;
      const url = /Serving .* at (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
      const token = /x-site-to-api-token: (\S+)/.exec(text)?.[1];
      if (!url || !token) return;
      child.stdout.off("data", onData);
      resolvePromise({ url, token });
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
  });
}
