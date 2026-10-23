import {
  prepareCutoverFixture,
  createCutoverRuntime,
  installCutoverCleanup,
  waitFor,
  isProcessRunning,
} from "./pi-mcp-cutover-fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production capability registration reaches Pi MCP with env credentials and the CLI bridge", async (t) => {
  const {
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
  } = await prepareCutoverFixture();
  const { pi, capabilityTools, chatId, activationId } = await createCutoverRuntime(
    workingDirectory,
    agentDirectory,
    sessionDirectory,
    dataDirectory,
    registryPath,
    store,
    registry,
  );
  await installCutoverCleanup(t, root, pidFile, credentialEnvName, priorCredential, pi);
  const { handle } = await registerFixtureMcp(
    workingDirectory,
    serverPath,
    credentialEnvName,
    pi,
    capabilityTools,
    chatId,
    activationId,
  );
  const { initialPid, registeredCli } = await registerCliAndCheckMcp(
    workingDirectory,
    pidFile,
    credentialFile,
    credentialValue,
    capabilityTools,
    chatId,
    handle,
  );
  await verifyCliReload(pidFile, handle, initialPid, registeredCli);
  await verifyCredentialIsolation(
    registryPath,
    piConfigPath,
    pidFile,
    credentialEnvName,
    credentialValue,
    handle,
  );
  await verifyManualAuthCapability(piConfigPath, serverPath, capabilityTools, chatId);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function registerFixtureMcp(
  workingDirectory,
  serverPath,
  credentialEnvName,
  pi,
  capabilityTools,
  chatId,
  activationId,
) {
  const registeredMcp = await capabilityTools.execute(chatId, randomUUID(), "register_capability", {
    expectedRevision: 0,
    capability: {
      id: "cap_fixture",
      kind: "mcp",
      displayName: "Fixture MCP",
      description: "Production cutover fixture.",
      configReference: "local-fixture",
      credentialReference: `env:${credentialEnvName}`,
      relatedSkillIds: [],
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      endpoint: null,
      workingDirectory: null,
    },
  });
  assert.equal(JSON.parse(registeredMcp).revision, 1);
  const handle = await pi.openOrCreate({
    chatId,
    activationId,
    workingDirectory,
    reference: null,
    materialized: false,
  });
  return { handle };
}

async function registerCliAndCheckMcp(
  workingDirectory,
  pidFile,
  credentialFile,
  credentialValue,
  capabilityTools,
  chatId,
  handle,
) {
  await waitFor(
    () =>
      handle
        .effectiveResources()
        .mcpServers.some(({ name, state }) => name === "pippin_fixture" && state === "connected"),
    () =>
      `Pi MCP fixture connection; statuses=${JSON.stringify(handle.effectiveResources().mcpServers)}`,
  );
  assert.ok(
    handle
      .effectiveResources()
      .mcpServers.some(
        ({ name, state, toolCount }) =>
          name === "pippin_fixture" && state === "connected" && toolCount === 1,
      ),
  );
  assert.equal((await readFile(credentialFile, "utf8")).trim(), credentialValue);
  const initialPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isSafeInteger(initialPid));
  const registeredCli = await capabilityTools.execute(chatId, randomUUID(), "register_capability", {
    expectedRevision: 1,
    capability: {
      id: "cap_fixture_cli",
      kind: "cli",
      displayName: "Fixture CLI",
      description: "Registered CLI bridge fixture.",
      configReference: "local-fixture",
      credentialReference: null,
      relatedSkillIds: [],
      launcher: { executable: process.execPath, workingDirectory },
    },
  });
  return { initialPid, registeredCli };
}

async function verifyCliReload(pidFile, handle, initialPid, registeredCli) {
  assert.equal(JSON.parse(registeredCli).revision, 2);
  await waitFor(
    () =>
      handle
        .effectiveResources()
        .mcpServers.some(({ name, state }) => name === "pippin_cli" && state === "connected") &&
      handle
        .effectiveResources()
        .mcpServers.some(({ name, state }) => name === "pippin_fixture" && state === "connected"),
    () =>
      `Pi CLI bridge connection after a live config reload; statuses=${JSON.stringify(handle.effectiveResources().mcpServers)}`,
  );
  const pidsAfterReload = (await readFile(pidFile, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number);
  assert.equal(pidsAfterReload.length, 2);
  await waitFor(
    () => !isProcessRunning(initialPid),
    () => "old Pi MCP child cleanup after the live config reload",
  );
  const statuses = handle.effectiveResources().mcpServers;
  assert.ok(
    statuses.some(
      ({ name, state, toolCount }) =>
        name === "pippin_fixture" && state === "connected" && toolCount === 1,
    ),
  );
  assert.ok(
    statuses.some(
      ({ name, state, toolCount }) =>
        name === "pippin_cli" && state === "connected" && toolCount === 3,
    ),
  );
}

async function verifyCredentialIsolation(
  registryPath,
  piConfigPath,
  pidFile,
  credentialEnvName,
  credentialValue,
  handle,
) {
  assert.ok(
    handle.effectiveResources().tools.some(({ name, active }) => name === "codemode" && active),
  );
  const mcpConfig = await readFile(piConfigPath, "utf8");
  assert.match(mcpConfig, new RegExp(`\\$\\{${credentialEnvName}\\}`));
  assert.doesNotMatch(mcpConfig, new RegExp(escapeRegExp(credentialValue)));
  assert.doesNotMatch(
    await readFile(registryPath, "utf8"),
    new RegExp(escapeRegExp(credentialValue)),
  );
  assert.ok((await readFile(pidFile, "utf8")).trim());
}

async function verifyManualAuthCapability(piConfigPath, serverPath, capabilityTools, chatId) {
  const registeredExternalMcp = await capabilityTools.execute(
    chatId,
    randomUUID(),
    "register_capability",
    {
      expectedRevision: 2,
      capability: {
        id: "cap_manual_auth",
        kind: "mcp",
        displayName: "Manual Auth MCP",
        description: "Requires Pi-managed credentials.",
        configReference: "local-registry",
        credentialReference: "external-config-only",
        relatedSkillIds: [],
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        endpoint: null,
        workingDirectory: null,
      },
    },
  );
  assert.equal(JSON.parse(registeredExternalMcp).revision, 3);
  const manualAuth = (await capabilityTools.readManagementCatalog()).capabilities.find(
    ({ id }) => id === "cap_manual_auth",
  );
  assert.equal(manualAuth.credentialConfigured, true);
  assert.equal(manualAuth.credentialBinding, "manual_pi_binding_required");
  const finalConfig = JSON.parse(await readFile(piConfigPath, "utf8"));
  assert.equal(finalConfig.mcpServers.pippin_manual_auth.enabled, false);
  assert.equal(finalConfig.mcpServers.pippin_manual_auth.headers, undefined);
}
