import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export async function identifyInterruptedInstallerArtifacts({
  appDataRoot,
  daemonEntrypoint,
  hostConfigPath,
  hostExecutablePath,
  hostManifestPath,
}) {
  const config = JSON.parse(await readFile(hostConfigPath, "utf8"));
  const manifest = JSON.parse(await readFile(hostManifestPath, "utf8"));
  const installedExecutable = await readFile(hostExecutablePath);
  assert.ok(installedExecutable.length > 0, "interrupted host executable is empty");
  const nodeVersion = spawnSync(config.nodeExecutable, ["--version"], {
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(nodeVersion.status, 0);
  assert.equal(nodeVersion.stdout.trim(), "v22.19.0");
  assert.equal(
    resolve(config.nodeExecutable),
    resolve(
      tmpdir(),
      "pippin-node22.19-f6f3d3b89e1c4c4f8a17bf5b12537824",
      "node-v22.19.0-win-x64",
      "node.exe",
    ),
  );
  assert.equal(config.extensionId, "npcdopokfkpfmepknhoecppgdgmkmihh");
  assert.equal(config.daemonEntrypoint, daemonEntrypoint);
  assert.equal(config.dataDirectory, join(appDataRoot, "data"));
  assert.deepEqual(Object.keys(config).sort(), [
    "daemonEntrypoint",
    "dataDirectory",
    "extensionId",
    "nodeExecutable",
  ]);
  assert.equal(manifest.name, "com.pippin.native_host_dev");
  assert.equal(manifest.description, "Disposable Aeon Slice 3 native messaging host");
  assert.equal(manifest.path, hostExecutablePath);
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, [
    "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh/",
  ]);
  return {
    config: await readFile(hostConfigPath),
    manifest: await readFile(hostManifestPath),
    executableHash: createHash("sha256").update(installedExecutable).digest("hex"),
  };
}

export async function verifyPreservedInstallerArtifacts({
  before,
  hostConfigPath,
  hostExecutablePath,
  hostManifestPath,
}) {
  const currentConfig = await readFile(hostConfigPath).catch(() => undefined);
  const currentManifest = await readFile(hostManifestPath).catch(() => undefined);
  const currentExecutableHash = createHash("sha256")
    .update(await readFile(hostExecutablePath))
    .digest("hex");
  if (
    !currentConfig?.equals(before.config) ||
    !currentManifest?.equals(before.manifest) ||
    currentExecutableHash !== before.executableHash
  ) {
    throw new Error("Pre-existing interrupted installer files changed during the probe");
  }
}
