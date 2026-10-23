import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityRegistry } from "../dist/capability-registry.js";
import { CapabilityToolService } from "../dist/capability-tool-service.js";
import { PiMcpConfigMigration } from "../dist/pi-mcp-config-migration.js";
import { PiSdkSessionAdapter } from "@aeon/pi-adapter";
export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate, describe) {
  const deadline = Date.now() + 12_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${describe()}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function fixtureMcpServer(pidFile, credentialFile, credentialEnvName) {
  return `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
await appendFile(${JSON.stringify(pidFile)}, String(process.pid) + "\\n", "utf8");
await appendFile(${JSON.stringify(credentialFile)}, String(process.env[${JSON.stringify(credentialEnvName)}] ?? "") + "\\n", "utf8");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(message, "id")) continue;
  let result = {};
  if (message.method === "initialize") {
    result = { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } };
  } else if (message.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Fixture tool.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
  } else if (message.method === "resources/list") {
    result = { resources: [] };
  } else if (message.method === "resources/templates/list") {
    result = { resourceTemplates: [] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`;
}

export async function prepareCutoverFixture() {
  const root = await mkdtemp(join(tmpdir(), "aeon-production-mcp-cutover-"));
  const workingDirectory = join(root, "project");
  const agentDirectory = join(root, "pi-agent");
  const sessionDirectory = join(root, "pi-sessions");
  const dataDirectory = join(root, "aeon-data");
  const registryPath = join(dataDirectory, "capabilities.json");
  const piConfigPath = join(agentDirectory, "mcp.json");
  const serverPath = join(root, "fixture-mcp-server.mjs");
  const pidFile = join(root, "fixture-pids.txt");
  const credentialFile = join(root, "fixture-credential.txt");
  const credentialEnvName = `AEON_MCP_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const credentialValue = `fixture-secret-${randomUUID()}`;
  const priorCredential = process.env[credentialEnvName];
  process.env[credentialEnvName] = credentialValue;
  await Promise.all([
    mkdir(workingDirectory, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(dataDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(serverPath, fixtureMcpServer(pidFile, credentialFile, credentialEnvName), "utf8"),
    writeFile(pidFile, "", "utf8"),
    writeFile(credentialFile, "", "utf8"),
  ]);
  const audit = [];
  const store = {
    listCapabilityAudit: (limit) => audit.slice(0, limit),
    appendCapabilityAudit: (record) => audit.unshift(record),
  };
  const registry = new CapabilityRegistry(registryPath, store);
  await registry.initialize();
  return {
    root,
    workingDirectory,
    agentDirectory,
    sessionDirectory,
    dataDirectory,
    registryPath,
    piConfigPath,
    serverPath,
    pidFile,
    credentialFile,
    credentialEnvName,
    credentialValue,
    priorCredential,
    store,
    registry,
  };
}

export async function createCutoverRuntime(
  workingDirectory,
  agentDirectory,
  sessionDirectory,
  dataDirectory,
  registryPath,
  store,
  registry,
) {
  const migration = new PiMcpConfigMigration({
    dataDirectory,
    legacyRegistryPath: registryPath,
    piAgentDirectory: agentDirectory,
    defaultWorkingDirectory: workingDirectory,
    cliBridge: {
      command: process.execPath,
      scriptPath: fileURLToPath(new URL("../dist/cli-mcp-bridge.js", import.meta.url)),
      registryPath,
    },
  });
  const pi = new PiSdkSessionAdapter({ sessionDirectory, agentDirectory });
  const capabilityTools = new CapabilityToolService(
    registry,
    migration,
    {
      reloadAllResources: () => pi.reloadAllResources(),
      reloadChatResources: (chatId) => pi.reloadChatResources(chatId),
    },
    store,
    {},
  );
  const chatId = randomUUID();
  const activationId = randomUUID();
  return { pi, capabilityTools, chatId, activationId };
}

export async function installCutoverCleanup(
  t,
  root,
  pidFile,
  credentialEnvName,
  priorCredential,
  pi,
) {
  t.after(async () => {
    try {
      await pi.closeAll();
      const pids = (await readFile(pidFile, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(Number);
      await waitFor(
        () => pids.every((pid) => !isProcessRunning(pid)),
        () => "production Pi MCP child cleanup after Chat close",
      );
    } finally {
      if (priorCredential === undefined) delete process.env[credentialEnvName];
      else process.env[credentialEnvName] = priorCredential;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
