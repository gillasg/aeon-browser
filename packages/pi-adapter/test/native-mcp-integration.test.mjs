import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  bindPiExtensions,
  createPiResourceLoader,
  reloadPiResources,
} from "../dist/sdk-resources.js";
import { createLocalFixtureModel } from "../dist/fixture-model.js";
import { ExtensionUiBridge } from "../dist/extension-ui-bridge.js";
import { wrapPiSession } from "../dist/session-projection.js";

test("Pi owns an MCP connection and restores its tool and status after resource reload", async (t) => {
  const {
    root,
    workingDirectory,
    agentDirectory,
    sessionDirectory,
    pidFile,
    serverPath,
    settingsManager,
    statuses,
  } = await prepareNativeMcpIntegrationCase1Stage1();
  const { resourceLoader, fixture, activationId, manager } =
    await verifyNativeMcpIntegrationCase1Stage2(
      workingDirectory,
      agentDirectory,
      sessionDirectory,
      pidFile,
      serverPath,
      settingsManager,
      statuses,
    );
  const { session, handle } = await verifyNativeMcpIntegrationCase1Stage3(
    workingDirectory,
    agentDirectory,
    settingsManager,
    statuses,
    resourceLoader,
    fixture,
    activationId,
    manager,
  );
  const { firstPid } = await verifyNativeMcpIntegrationCase1Stage4(
    t,
    root,
    pidFile,
    statuses,
    session,
    handle,
  );
  await verifyNativeMcpIntegrationCase1Stage5(pidFile, statuses, session, firstPid);
});

function latestStatus(snapshots) {
  return snapshots.at(-1)?.find(({ name }) => name === "fixture");
}

function projectedStatuses(snapshots) {
  return snapshots.map((snapshot) =>
    snapshot.map(({ name, state, toolCount, resourceCount }) => ({
      name,
      state,
      toolCount,
      resourceCount,
    })),
  );
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, description = "the expected state") {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`The Pi MCP fixture did not reach ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixtureMcpServer(pidFile) {
  return `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
await appendFile(${JSON.stringify(pidFile)}, String(process.pid) + "\\n", "utf8");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(message, "id")) continue;
  let result = {};
  if (message.method === "initialize") {
    result = {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1.0.0" },
    };
  } else if (message.method === "tools/list") {
    result = {
      tools: [{
        name: "echo",
        description: "Return the supplied fixture text.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      }],
    };
  } else if (message.method === "tools/call") {
    result = { content: [{ type: "text", text: message.params?.arguments?.text ?? "ok" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`;
}

async function prepareNativeMcpIntegrationCase1Stage1() {
  const root = await mkdtemp(join(tmpdir(), "pippin-native-mcp-"));
  const workingDirectory = join(root, "project");
  const agentDirectory = join(root, "pi-agent");
  const sessionDirectory = join(root, "sessions");
  const pidFile = join(root, "server-pids.txt");
  const serverPath = join(root, "fixture-mcp-server.mjs");
  await Promise.all([
    mkdir(workingDirectory, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(pidFile, "", "utf8");
  await writeFile(serverPath, fixtureMcpServer(pidFile), "utf8");
  const settingsManager = SettingsManager.create(workingDirectory, agentDirectory);
  const statuses = [];
  return {
    root,
    workingDirectory,
    agentDirectory,
    sessionDirectory,
    pidFile,
    serverPath,
    settingsManager,
    statuses,
  };
}

async function verifyNativeMcpIntegrationCase1Stage2(
  workingDirectory,
  agentDirectory,
  sessionDirectory,
  pidFile,
  serverPath,
  settingsManager,
  statuses,
) {
  const resourceLoader = createPiResourceLoader({
    workingDirectory,
    agentDirectory,
    settingsManager,
    mcpOptions: {
      loadConfig: () => ({
        servers: [
          {
            name: "fixture",
            source: "fixture",
            config: {
              type: "stdio",
              command: process.execPath,
              args: [serverPath],
              cwd: workingDirectory,
              env: { PIPPIN_MCP_PID_FILE: pidFile },
              enabled: true,
              exposure: "codemode",
            },
          },
        ],
        errors: [],
      }),
      onStatusChange: (servers) => statuses.push(servers),
    },
  });
  await resourceLoader.reload();
  const fixture = await createLocalFixtureModel(agentDirectory);
  const activationId = randomUUID();
  const manager = SessionManager.create(workingDirectory, sessionDirectory, { id: activationId });
  return { resourceLoader, fixture, activationId, manager };
}

async function verifyNativeMcpIntegrationCase1Stage3(
  workingDirectory,
  agentDirectory,
  settingsManager,
  statuses,
  resourceLoader,
  fixture,
  activationId,
  manager,
) {
  const { session } = await createAgentSession({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    modelRuntime: fixture.modelRuntime,
    model: fixture.model,
  });
  const extensionUi = new ExtensionUiBridge(session);
  await bindPiExtensions(session, extensionUi.context);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const handle = wrapPiSession(
    session,
    manager,
    { sessionId: activationId, sessionFile },
    randomUUID(),
    extensionUi,
    () => (latestStatus(statuses) ? [latestStatus(statuses)] : []),
  );
  return { session, handle };
}

async function verifyNativeMcpIntegrationCase1Stage4(t, root, pidFile, statuses, session, handle) {
  t.after(async () => {
    await handle.close();
    const allPids = (await readFile(pidFile, "utf8").catch(() => ""))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(Number);
    await waitFor(
      () => allPids.every((pid) => !isProcessRunning(pid)),
      "MCP child processes to stop",
    );
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(
    () => latestStatus(statuses)?.state === "connected",
    `initial MCP connection; statuses=${JSON.stringify(projectedStatuses(statuses))}`,
  );
  assert.equal(latestStatus(statuses)?.name, "fixture");
  assert.equal(latestStatus(statuses)?.toolCount, 1);
  assert.ok(
    session.extensionRunner
      .getAllRegisteredTools()
      .some(({ definition }) => definition.name === "mcp__fixture__echo"),
    `Pi extension registry did not contain fixture echo: ${JSON.stringify(session.extensionRunner.getAllRegisteredTools().map(({ definition }) => ({ name: definition.name, exposure: definition.exposure })))}`,
  );
  assert.ok(session.getActiveToolNames().includes("codemode"));
  const firstPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isSafeInteger(firstPid));
  await reloadPiResources(session);
  return { firstPid };
}

async function verifyNativeMcpIntegrationCase1Stage5(pidFile, statuses, session, firstPid) {
  await waitFor(
    () => latestStatus(statuses)?.state === "connected" && statuses.length > 2,
    `MCP reconnection after reload; statuses=${JSON.stringify(projectedStatuses(statuses))}`,
  );
  assert.equal(latestStatus(statuses)?.toolCount, 1);
  assert.ok(
    session.extensionRunner
      .getAllRegisteredTools()
      .some(({ definition }) => definition.name === "mcp__fixture__echo"),
  );
  assert.ok(session.getActiveToolNames().includes("codemode"));
  const pids = (await readFile(pidFile, "utf8")).trim().split(/\r?\n/).map(Number);
  assert.equal(pids.length, 2);
  await waitFor(() => !isProcessRunning(firstPid));
}
