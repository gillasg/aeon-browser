import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiMcpConfigMigration } from "../dist/pi-mcp-config-migration.js";

test("Pi MCP migration snapshots originals and preserves Pi-owned settings on registry sync", async (t) => {
  const { paths, originalPiConfig, originalRegistry, migration, written } =
    await preparePiMcpConfigMigrationCase1Stage1(t);
  await verifyPiMcpConfigMigrationCase1Stage2(
    paths,
    originalPiConfig,
    originalRegistry,
    migration,
    written,
  );
});

test("Pi MCP registry edits update transport fields and retain Pi enable/exposure choices", async (t) => {
  const paths = await makePaths(t);
  const migration = new PiMcpConfigMigration(paths.input);
  await migration.migrate(registry);
  const current = JSON.parse(await readFile(paths.piConfig, "utf8"));
  current.mcpServers.pippin_docs.enabled = false;
  current.mcpServers.pippin_docs.exposure = "hidden";
  await writeFile(paths.piConfig, JSON.stringify(current, null, 2), "utf8");

  const changedRegistry = structuredClone(registry);
  changedRegistry.revision += 1;
  changedRegistry.capabilities[0].command = "docs-mcp-v2";
  await migration.migrate(changedRegistry);

  const updated = JSON.parse(await readFile(paths.piConfig, "utf8"));
  assert.equal(updated.mcpServers.pippin_docs.command, "docs-mcp-v2");
  assert.equal(updated.mcpServers.pippin_docs.enabled, false);
  assert.equal(updated.mcpServers.pippin_docs.exposure, "hidden");
});

test("Pi MCP migration completes a prepared manifest after its config write", async (t) => {
  const paths = await makePaths(t);
  const migration = new PiMcpConfigMigration(paths.input);
  await migration.migrate(registry);
  const previousManifestPath = join(paths.input.dataDirectory, "pi-migration", "mcp-manifest.json");
  const previousManifest = JSON.parse(await readFile(previousManifestPath, "utf8"));
  const changedRegistry = structuredClone(registry);
  changedRegistry.revision += 1;
  changedRegistry.capabilities[0].command = "docs-mcp-v2";
  await migration.migrate(changedRegistry);

  const prepared = JSON.parse(await readFile(previousManifestPath, "utf8"));
  prepared.status = "prepared";
  prepared.completedAt = null;
  prepared.previousServers = previousManifest.servers;
  await writeFile(previousManifestPath, JSON.stringify(prepared, null, 2), "utf8");
  const recovered = await migration.migrate(changedRegistry);

  assert.equal(recovered.status, "migrated");
  const completed = JSON.parse(await readFile(previousManifestPath, "utf8"));
  assert.equal(completed.status, "complete");
  assert.equal(Object.hasOwn(completed, "previousServers"), false);
  assert.equal(
    JSON.parse(await readFile(paths.piConfig, "utf8")).mcpServers.pippin_docs.command,
    "docs-mcp-v2",
  );
});

test("Pi MCP removal removes an owned row after Pi enable/exposure changes", async (t) => {
  const paths = await makePaths(t);
  const migration = new PiMcpConfigMigration(paths.input);
  await migration.migrate(registry);
  const current = JSON.parse(await readFile(paths.piConfig, "utf8"));
  current.mcpServers.pippin_docs.enabled = false;
  current.mcpServers.pippin_docs.exposure = "hidden";
  await writeFile(paths.piConfig, JSON.stringify(current, null, 2), "utf8");

  await migration.migrate({ ...registry, revision: registry.revision + 1, capabilities: [] });

  const updated = JSON.parse(await readFile(paths.piConfig, "utf8"));
  assert.equal(Object.hasOwn(updated.mcpServers, "pippin_docs"), false);
});

test("Pi MCP registry sync preserves manual transport edits and rejects a conflicting update", async (t) => {
  const paths = await makePaths(t);
  const migration = new PiMcpConfigMigration(paths.input);
  await migration.migrate(registry);
  const current = JSON.parse(await readFile(paths.piConfig, "utf8"));
  current.mcpServers.pippin_docs.command = "user-selected-command";
  await writeFile(paths.piConfig, JSON.stringify(current, null, 2), "utf8");

  const changedRegistry = structuredClone(registry);
  changedRegistry.revision += 1;
  changedRegistry.capabilities[0].command = "docs-mcp-v2";
  await assert.rejects(() => migration.validate(changedRegistry), /edited in Pi/);
  assert.equal(
    JSON.parse(await readFile(paths.piConfig, "utf8")).mcpServers.pippin_docs.command,
    "user-selected-command",
  );
});

test("Pi MCP migration does not recreate a server removed in Pi", async (t) => {
  const paths = await makePaths(t);
  const migration = new PiMcpConfigMigration(paths.input);
  await migration.migrate(registry);
  const current = JSON.parse(await readFile(paths.piConfig, "utf8"));
  delete current.mcpServers.pippin_docs;
  await writeFile(paths.piConfig, JSON.stringify(current, null, 2), "utf8");

  await migration.migrate({ ...registry, revision: registry.revision + 1 });

  const updated = JSON.parse(await readFile(paths.piConfig, "utf8"));
  assert.equal(Object.hasOwn(updated.mcpServers, "pippin_docs"), false);
});

test("Pi MCP migration registers one dynamic bridge for explicitly registered CLIs", async (t) => {
  const paths = await makePaths(t);
  const migration = new PiMcpConfigMigration({
    ...paths.input,
    cliBridge: {
      command: "C:/runtime/node.exe",
      scriptPath: "C:/aeon/cli-mcp-bridge.js",
      registryPath: paths.registryPath,
    },
  });
  const cliRegistry = {
    ...registry,
    capabilities: [
      {
        id: "cap_wrangler",
        kind: "cli",
        displayName: "Wrangler",
        description: "Cloudflare CLI.",
        configReference: "registry",
        credentialReference: null,
        relatedSkillIds: [],
        verification: { state: "needs_check", checkedAt: null, summary: null },
        launcher: { executable: "C:/tools/wrangler.exe", workingDirectory: null },
      },
    ],
  };

  await migration.migrate(cliRegistry);
  const configured = JSON.parse(await readFile(paths.piConfig, "utf8"));
  assert.deepEqual(configured.mcpServers.pippin_cli, {
    type: "stdio",
    command: "C:/runtime/node.exe",
    args: ["C:/aeon/cli-mcp-bridge.js", "--registry", paths.registryPath],
    cwd: "C:\\aeon",
    description: "The command-line tools the user registered in Aeon.",
    enabled: true,
    exposure: "codemode",
  });

  await migration.migrate({ ...cliRegistry, revision: cliRegistry.revision + 1, capabilities: [] });
  const removed = JSON.parse(await readFile(paths.piConfig, "utf8"));
  assert.equal(Object.hasOwn(removed.mcpServers, "pippin_cli"), false);
});

test("Pi MCP migration rejects a server-name collision without changing the source config", async (t) => {
  const paths = await makePaths(t);
  const original = JSON.stringify({
    mcpServers: {
      pippin_docs: { type: "stdio", command: "different-command" },
    },
  });
  await writeFile(paths.piConfig, original, "utf8");
  const migration = new PiMcpConfigMigration(paths.input);

  await assert.rejects(() => migration.migrate(registry), /conflicting server named 'pippin_docs'/);
  assert.equal(await readFile(paths.piConfig, "utf8"), original);
});

async function makePaths(t) {
  const root = await mkdtemp(join(tmpdir(), "aeon-mcp-migration-"));
  const piAgentDirectory = join(root, "pi-agent");
  const dataDirectory = join(root, "aeon-data");
  await Promise.all([
    mkdir(piAgentDirectory, { recursive: true }),
    mkdir(dataDirectory, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    piConfig: join(piAgentDirectory, "mcp.json"),
    registryPath: join(dataDirectory, "capabilities.json"),
    registryBackupPath: join(dataDirectory, "pi-migration", "capabilities.original.json"),
    mcpConfigBackupPath: join(dataDirectory, "pi-migration", "mcp.original.json"),
    input: {
      dataDirectory,
      legacyRegistryPath: join(dataDirectory, "capabilities.json"),
      piAgentDirectory,
      defaultWorkingDirectory: "C:/aeon",
    },
  };
}

const registry = {
  schemaVersion: 1,
  revision: 7,
  capabilities: [
    {
      id: "cap_docs",
      kind: "mcp",
      displayName: "Documentation",
      description: "Read local docs.",
      configReference: "registry",
      credentialReference: "env:DOCS_TOKEN",
      relatedSkillIds: [],
      verification: { state: "verified", checkedAt: null, summary: null },
      transport: "stdio",
      command: "docs-mcp",
      args: ["--read-only"],
      endpoint: null,
      workingDirectory: null,
    },
  ],
};

async function preparePiMcpConfigMigrationCase1Stage1(t) {
  const paths = await makePaths(t);
  const originalPiConfig = `${JSON.stringify(
    {
      autoEnableCodemode: true,
      mcpServers: {
        personal: { type: "http", url: "https://personal.example/mcp", enabled: false },
      },
    },
    null,
    2,
  )}\n`;
  const originalRegistry = `${JSON.stringify(registry)}\n`;
  await writeFile(paths.piConfig, originalPiConfig, "utf8");
  await writeFile(paths.registryPath, originalRegistry, "utf8");
  const migration = new PiMcpConfigMigration(paths.input);
  const first = await migration.migrate(registry);
  assert.deepEqual(first, {
    status: "migrated",
    registryRevision: 7,
    serverCount: 1,
    manualCredentialBindingCount: 0,
  });
  const written = JSON.parse(await readFile(paths.piConfig, "utf8"));
  assert.deepEqual(written.mcpServers.personal, {
    type: "http",
    url: "https://personal.example/mcp",
    enabled: false,
  });
  return { paths, originalPiConfig, originalRegistry, migration, written };
}

async function verifyPiMcpConfigMigrationCase1Stage2(
  paths,
  originalPiConfig,
  originalRegistry,
  migration,
  written,
) {
  assert.deepEqual(written.mcpServers.pippin_docs, {
    type: "stdio",
    command: "docs-mcp",
    args: ["--read-only"],
    cwd: "C:\\aeon",
    env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
    description: "Documentation: Read local docs.",
    enabled: true,
    exposure: "codemode",
  });
  const unchanged = await migration.migrate(registry);
  assert.deepEqual(unchanged, {
    status: "already-migrated",
    registryRevision: 7,
    serverCount: 1,
    manualCredentialBindingCount: 0,
  });
  written.mcpServers.pippin_docs.enabled = false;
  written.mcpServers.pippin_docs.exposure = "hidden";
  await writeFile(paths.piConfig, JSON.stringify(written, null, 2), "utf8");
  const second = await migration.migrate({ ...registry, revision: 8 });
  assert.deepEqual(second, {
    status: "migrated",
    registryRevision: 8,
    serverCount: 1,
    manualCredentialBindingCount: 0,
  });
  const preserved = JSON.parse(await readFile(paths.piConfig, "utf8"));
  assert.equal(preserved.mcpServers.pippin_docs.enabled, false);
  assert.equal(preserved.mcpServers.pippin_docs.exposure, "hidden");
  assert.equal(await readFile(paths.registryBackupPath, "utf8"), originalRegistry);
  assert.equal(await readFile(paths.mcpConfigBackupPath, "utf8"), originalPiConfig);
}
