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
  const root = await mkdtemp(join(tmpdir(), "pippin-cli-bridge-"));
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
  assert.equal(initialized.result.serverInfo.name, "pippin-cli");
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
