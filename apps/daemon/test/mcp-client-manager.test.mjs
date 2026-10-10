import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpClientManager } from "../dist/mcp-client-manager.js";

test("MCP stdio discovery validates and invokes a tool over the pinned client", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-mcp-smoke-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serverPath = join(directory, "server.mjs");
  await writeFile(
    serverPath,
    `import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === "initialize") {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "smoke", version: "1" } };
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] };
  } else if (request.method === "tools/call") {
    result = { content: [{ type: "text", text: request.params.arguments.text }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
    "utf8",
  );
  const capability = {
    id: "cap_smoke",
    kind: "mcp",
    transport: "stdio",
    command: process.execPath,
    args: [serverPath],
    endpoint: null,
    workingDirectory: directory,
    displayName: "MCP smoke fixture",
    description: "Ephemeral local MCP test fixture.",
    configReference: "fixture",
    credentialReference: null,
    relatedSkillIds: [],
    verification: { state: "needs_check", checkedAt: null, summary: null },
  };
  const registry = { snapshot: async () => ({ revision: 1, capabilities: [capability] }) };
  const manager = new McpClientManager(registry);
  try {
    const discovered = await manager.listMcpTools(capability.id);
    assert.equal(discovered.servers[0].connection, "connected", JSON.stringify(discovered));
    assert.equal(discovered.servers[0].tools[0].name, "echo");
    const result = await manager.callMcpTool(capability.id, "echo", { text: "smoke" });
    assert.deepEqual(result, {
      serverId: capability.id,
      toolName: "echo",
      isError: false,
      content: [{ type: "text", text: "smoke" }],
    });
  } finally {
    await manager.closeAll();
  }
});
