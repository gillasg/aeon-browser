import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mcpServersCommand, parseMcpAdd } from "../dist/mcp-servers-cmd.js";

async function registry(t) {
  const directory = await mkdtemp(join(tmpdir(), "graft-mcp-add-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capabilities.json");
  const lines = [];
  const run = (argv) => mcpServersCommand(argv, (line) => lines.push(line), path, directory);
  const read = async () => JSON.parse(await readFile(path, "utf8"));
  return { run, read, lines, directory };
}

test("graft mcp add <name> -- <cmd> registers a stdio server with its own flags intact", async (t) => {
  const { run, read, directory } = await registry(t);
  assert.equal(await run(["add", "notion", "--", "npx", "-y", "notion-mcp", "--stdio"]), 0);
  const file = await read();
  assert.equal(file.revision, 1);
  assert.deepEqual(file.capabilities[0], {
    id: "cap_notion",
    kind: "mcp",
    displayName: "notion",
    description: "MCP server notion",
    configReference: "graft mcp add",
    credentialReference: null,
    relatedSkillIds: [],
    verification: { state: "needs_check", checkedAt: null, summary: null },
    transport: "stdio",
    command: "npx",
    args: ["-y", "notion-mcp", "--stdio"],
    endpoint: null,
    workingDirectory: directory,
  });
  await assert.rejects(run(["add", "notion", "--", "x"]), /already registered/);
});

test("graft mcp add <name> --url with repeated --header stores only env references", async (t) => {
  const { run, read, lines } = await registry(t);
  await run([
    "add",
    "Acme API",
    "--url",
    "https://acme.example/mcp",
    "--header",
    "x-api-key=env:ACME_KEY",
    "--header=X-Org=env:ACME_ORG",
  ]);
  const [capability] = (await read()).capabilities;
  assert.equal(capability.id, "cap_acme_api");
  assert.equal(capability.transport, "streamable-http");
  assert.equal(capability.endpoint, "https://acme.example/mcp");
  assert.equal(
    capability.credentialReference,
    "header:x-api-key=env:ACME_KEY,header:X-Org=env:ACME_ORG",
  );
  lines.length = 0;
  await run(["list"]);
  assert.match(lines[0], /Acme API\s+cap_acme_api\s+streamable-http/);
  assert.equal(await run(["remove", "Acme API"]), 0);
  assert.deepEqual((await read()).capabilities, []);
  assert.equal(await run(["remove", "Acme API"]), 1);
});

test("graft mcp add refuses bad input before writing anything", () => {
  assert.throws(() => parseMcpAdd(["x"]), /either -- <command>/);
  assert.throws(() => parseMcpAdd(["x", "--url", "u", "--", "cmd"]), /either/);
  assert.throws(() => parseMcpAdd(["x", "--bogus", "1", "--", "cmd"]), /unknown option/);
});

test("invalid headers and secret-bearing URLs are rejected", async (t) => {
  const { run } = await registry(t);
  await assert.rejects(
    run(["add", "a", "--url", "https://a.example", "--header", "bad name=env:K"]),
    /not a valid header name/,
  );
  await assert.rejects(
    run(["add", "a", "--url", "https://a.example", "--header", "x-key=raw-secret"]),
    /<Name>=env:<VAR>/,
  );
  await assert.rejects(run(["add", "a", "--url", "https://a.example/?api_key=1"]), /credentials/);
  await assert.rejects(run(["add", "a", "--", "srv", "--token=abc"]), /cannot carry secrets/);
});
