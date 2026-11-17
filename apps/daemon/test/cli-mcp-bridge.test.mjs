import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Pi CLI bridge reads explicit registrations and preserves argv boundaries", async (t) => {
  const { root, registryPath, bridgePath } = await prepareCliMcpBridgeCase1Stage1();
  const { child, responses } = await verifyCliMcpBridgeCase1Stage2(
    t,
    root,
    registryPath,
    bridgePath,
  );
  await verifyCliMcpBridgeCase1Stage3(child, responses);
});

async function prepareCliMcpBridgeCase1Stage1() {
  const root = await mkdtemp(join(tmpdir(), "aeon-cli-bridge-"));
  const registryPath = join(root, "capabilities.json");
  const fixturePath = join(root, "fixture-cli.mjs");
  const bridgePath = fileURLToPath(new URL("../dist/cli-mcp-bridge.js", import.meta.url));
  await writeFile(
    fixturePath,
    `process.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    "utf8",
  );
  await writeFile(
    registryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      capabilities: [
        {
          id: "cap_fixture",
          kind: "cli",
          displayName: "Fixture CLI",
          description: "Test command.",
          configReference: "registry",
          credentialReference: null,
          relatedSkillIds: [],
          verification: { state: "needs_check", checkedAt: null, summary: null },
          launcher: { executable: process.execPath, workingDirectory: root },
        },
      ],
    })}\n`,
    "utf8",
  );
  return { root, registryPath, bridgePath };
}

async function verifyCliMcpBridgeCase1Stage2(t, root, registryPath, bridgePath) {
  const child = spawn(process.execPath, [bridgePath, "--registry", registryPath], {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  const responses = new Map();
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on("line", (line) => {
    const response = JSON.parse(line);
    const resolveResponse = responses.get(response.id);
    if (resolveResponse) {
      responses.delete(response.id);
      resolveResponse(response);
    }
  });
  t.after(async () => {
    child.stdin.end();
    const forceKill = setTimeout(() => child.kill(), 1_000);
    await childClosed;
    clearTimeout(forceKill);
    output.close();
    await rm(root, { recursive: true, force: true });
  });
  return { child, responses };
}

async function verifyCliMcpBridgeCase1Stage3(child, responses) {
  const request = (id, method, params = {}) =>
    new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        responses.delete(id);
        reject(new Error(`MCP request '${method}' timed out.`));
      }, 5_000);
      responses.set(id, (response) => {
        clearTimeout(timer);
        resolveResponse(response);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const initialized = await request(1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.serverInfo.name, "aeon-cli");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const catalog = await request(2, "tools/call", {
    name: "cli_catalog",
    arguments: {},
  });
  assert.match(catalog.result.content[0].text, /cap_fixture/);
  assert.doesNotMatch(catalog.result.content[0].text, /cap_not_registered/);
  const execution = await request(3, "tools/call", {
    name: "cli_run",
    arguments: { capabilityId: "cap_fixture", args: ["fixture-cli.mjs", "two words"] },
  });
  const result = JSON.parse(execution.result.content[0].text);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["two words"]);
}

test("the CLI bridge speaks 2026-07-28 discover and _meta without breaking initialize", async (t) => {
  const { root, registryPath, bridgePath } = await prepareCliMcpBridgeCase1Stage1();
  const { child, responses } = await verifyCliMcpBridgeCase1Stage2(
    t,
    root,
    registryPath,
    bridgePath,
  );
  const send = (id, method, params = {}) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const wait = (id, ms = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        responses.delete(id);
        reject(new Error(`MCP request ${id} timed out.`));
      }, ms);
      responses.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

  // A 2026-07-28 client probes with server/discover: no initialize needed.
  send(101, "server/discover", {});
  const discovered = (await wait(101)).result;
  assert.equal(discovered.resultType, "complete");
  assert.match(discovered.supportedVersions.join(","), /2026-07-28/);
  assert.equal(discovered._meta["io.modelcontextprotocol/serverInfo"].name, "aeon-cli");

  const modern = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
  send(102, "tools/list", modern);
  const listed = (await wait(102)).result;
  assert.equal(listed.resultType, "complete", "modern list carries resultType");
  assert.equal(listed.ttlMs, 0);
  assert.equal(listed.cacheScope, "private");
  assert.ok(listed.tools.some((tool) => tool.name === "cli_run"));

  send(103, "tools/call", { ...modern, name: "cli_catalog", arguments: {} });
  const called = (await wait(103)).result;
  assert.equal(called.resultType, "complete", "modern call carries resultType");

  // An old client still initializes and gets the old shape (no resultType).
  send(1, "initialize", { protocolVersion: "2025-06-18" });
  const initialized = await wait(1);
  assert.equal(initialized.result.serverInfo.name, "aeon-cli");
  send(104, "tools/list", {});
  const oldListed = (await wait(104)).result;
  assert.equal(oldListed.resultType, undefined, "older clients keep the old result shape");
});

test("notifications/cancelled aborts a running call and sends no reply", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-cli-cancel-"));
  // A long-running CLI: cancellation must stop it, and no result may be written for the request.
  await writeFile(join(root, "sleep.mjs"), `setInterval(() => {}, 1000);\n`, "utf8");
  const registryPath = join(root, "capabilities.json");
  await writeFile(
    registryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      capabilities: [
        {
          id: "cap_sleep",
          kind: "cli",
          displayName: "Sleep",
          description: "Long command.",
          configReference: "registry",
          credentialReference: null,
          relatedSkillIds: [],
          verification: { state: "needs_check", checkedAt: null, summary: null },
          launcher: { executable: process.execPath, workingDirectory: root },
        },
      ],
    })}\n`,
    "utf8",
  );
  const bridgePath = fileURLToPath(new URL("../dist/cli-mcp-bridge.js", import.meta.url));
  const child = spawn(process.execPath, [bridgePath, "--registry", registryPath], {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const seen = [];
  lines.on("line", (line) => seen.push(JSON.parse(line)));
  t.after(async () => {
    child.stdin.end();
    const forceKill = setTimeout(() => child.kill(), 1_000);
    await childClosed;
    clearTimeout(forceKill);
    lines.close();
    // Remove the folder only after the bridge (and its CLI) closed: Windows keeps a cwd busy.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        name: "cli_run",
        arguments: { capabilityId: "cap_sleep", args: ["sleep.mjs"] },
      },
    })}\n`,
  );
  // Give the CLI a moment to start, then cancel the request by its JSON-RPC id.
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(
    !seen.some((line) => line.id === 9),
    "a cancelled call gets no reply, so it is not replayed",
  );
});
