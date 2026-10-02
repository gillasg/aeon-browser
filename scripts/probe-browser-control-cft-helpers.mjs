import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  identifyInterruptedInstallerArtifacts,
  verifyPreservedInstallerArtifacts,
} from "./probe-browser-control-cft-artifacts.mjs";

export class CftNativeHostSetup {
  constructor({ root, chromePath, nativeHostPath, daemonEntrypoint, localAppData }) {
    this.root = root;
    this.chromePath = chromePath;
    this.nativeHostPath = nativeHostPath;
    this.daemonEntrypoint = daemonEntrypoint;
    this.localAppData = localAppData;
    this.appDataRoot = join(localAppData ?? "", "Pippin", "Slice3Dev");
    this.hostConfigPath = join(this.appDataRoot, "host-config.json");
    this.hostManifestPath = join(this.appDataRoot, "com.pippin.native_host_dev.json");
    this.hostExecutablePath = join(this.appDataRoot, "pippin-native-host.exe");
    this.appDataDirectory = join(
      this.appDataRoot,
      `slice4-browser-probe-${randomUUID().replaceAll("-", "")}`,
    );
    this.extensionPath = undefined;
    this.extensionRoot = undefined;
    this.hostRoot = undefined;
    this.profilePath = undefined;
    this.extensionId = undefined;
    this.hostName = `com.pippin.slice4_${randomUUID().replaceAll("-", "")}`;
    this.hostConfigBefore = undefined;
    this.preexistingInstallerArtifacts = undefined;
    this.registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${this.hostName}`;
    this.registered = false;
    this.cleaned = false;
    this.hostConfigTouched = false;
    this.appDataPrefix = `${resolve(this.appDataRoot)}${sep}`;
    this.tempPrefix = `${resolve(tmpdir())}${sep}`;
  }

  async prepare() {
    assert.ok(existsSync(this.chromePath), "Chrome for Testing is unavailable");
    assert.ok(this.localAppData, "LocalAppData is unavailable");
    assert.ok(existsSync(this.nativeHostPath), "Build the native host before this probe");
    assert.ok(existsSync(this.daemonEntrypoint), "Build the daemon before this probe");
    assert.equal(
      process.versions.node,
      "22.19.0",
      "Run this probe with the bundled Node 22 runtime",
    );
    assert.equal(await hasPippinProcess(), false, "A Pippin daemon is already running");
    assert.equal(
      queryRegistry(this.registryKey).status,
      1,
      "The one-off browser host name is registered",
    );
    assert.equal(
      queryRegistry(
        "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.pippin.native_host_dev",
      ).status,
      1,
      "The shared development host is registered; refusing to use the interrupted installer state",
    );
    this.preexistingInstallerArtifacts = await identifyInterruptedInstallerArtifacts({
      appDataRoot: this.appDataRoot,
      daemonEntrypoint: this.daemonEntrypoint,
      hostConfigPath: this.hostConfigPath,
      hostExecutablePath: this.hostExecutablePath,
      hostManifestPath: this.hostManifestPath,
    });
    this.hostConfigBefore = await readFile(this.hostConfigPath).catch(() => undefined);
    assert.equal(
      existsSync(this.appDataDirectory),
      false,
      "The one-off database path already exists",
    );

    this.profilePath = await mkdtemp(join(tmpdir(), "pippin-slice4-cft-profile-"));
    this.extensionRoot = await mkdtemp(join(tmpdir(), "pippin-slice4-cft-extension-"));
    this.extensionPath = join(this.extensionRoot, "unpacked");
    this.hostRoot = await mkdtemp(join(tmpdir(), "pippin-slice4-cft-host-"));
    const key = await this.prepareExtension();
    this.extensionId = key.extensionId;
    this.hostName = key.hostName;
    const oneOffManifestPath = join(this.hostRoot, `${this.hostName}.json`);
    await this.writeHostConfiguration();
    await this.writeNativeHostManifest(oneOffManifestPath);
    this.registerNativeHost(oneOffManifestPath);
    return this;
  }

  async cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    const ownsHostConfiguration = this.hostConfigTouched;
    const errors = [];
    const attempt = async (task) => {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    };
    if (this.registered) this.unregisterNativeHost();
    if (ownsHostConfiguration && (await hasNativeSupervisor(this.nativeHostPath))) {
      const stopped = spawnSync(this.nativeHostPath, ["--stop-supervisor"], {
        windowsHide: true,
        timeout: 10_000,
      });
      if (stopped.error || stopped.status !== 0)
        errors.push(new Error("Disposable native supervisor did not confirm shutdown"));
    }
    if (this.hostConfigTouched) {
      if (this.hostConfigBefore)
        await attempt(() => writeFile(this.hostConfigPath, this.hostConfigBefore));
      else await attempt(() => unlink(this.hostConfigPath));
    }
    await attempt(() => this.removeDataDirectory());
    if (this.preexistingInstallerArtifacts)
      await attempt(() =>
        verifyPreservedInstallerArtifacts({
          before: this.preexistingInstallerArtifacts,
          hostConfigPath: this.hostConfigPath,
          hostExecutablePath: this.hostExecutablePath,
          hostManifestPath: this.hostManifestPath,
        }),
      );
    for (const target of [this.profilePath, this.extensionRoot, this.hostRoot])
      await attempt(() => this.removeTempDirectory(target));
    if (errors.length) throw new AggregateError(errors, "CFT probe cleanup was incomplete");
  }

  async prepareExtension() {
    const { key, extensionId } = await createExtensionIdentity();
    const hostName = this.hostName;
    const extensionSource = join(this.root, "apps", "chrome-extension", "native-dist");
    await prepareExtensionCopy(extensionSource, this.extensionPath, key, hostName);
    return { extensionId, hostName };
  }

  async writeHostConfiguration() {
    const dataPath = resolve(this.appDataDirectory);
    assert.ok(
      dataPath.startsWith(this.appDataPrefix),
      "disposable database escaped LocalAppData\\Pippin",
    );
    await mkdir(this.appDataRoot, { recursive: true });
    this.hostConfigTouched = true;
    await writeFile(
      this.hostConfigPath,
      `${JSON.stringify(
        {
          extensionId: this.extensionId,
          nodeExecutable: process.execPath,
          daemonEntrypoint: this.daemonEntrypoint,
          dataDirectory: dataPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async writeNativeHostManifest(path) {
    const manifest = {
      name: this.hostName,
      description: "Temporary Pippin Slice 4 CFT probe host",
      path: this.nativeHostPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${this.extensionId}/`],
    };
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  registerNativeHost(manifestPath) {
    const result = spawnSync(
      "reg.exe",
      ["add", this.registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(result.status, 0, "could not register the one-off CFT native host");
    this.registered = true;
  }

  unregisterNativeHost() {
    const result = spawnSync("reg.exe", ["delete", this.registryKey, "/f"], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.status !== 0) process.stderr.write("One-off native-host registry cleanup failed.\n");
    this.registered = false;
  }

  async removeDataDirectory() {
    const target = resolve(this.appDataDirectory);
    if (!target.startsWith(this.appDataPrefix) || !target.includes("slice4-browser-probe-")) {
      process.stderr.write("Disposable database path failed its cleanup guard.\n");
      return;
    }
    await rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }

  async removeTempDirectory(target) {
    if (!target) return;
    const fullPath = resolve(target);
    if (!fullPath.startsWith(this.tempPrefix) || !fullPath.includes("pippin-slice4-cft-")) {
      process.stderr.write("Temporary CFT path failed its cleanup guard.\n");
      return;
    }
    await rm(fullPath, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

async function createExtensionIdentity() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const key = publicKeyDer.toString("base64");
  const digest = createHash("sha256").update(publicKeyDer).digest();
  const extensionId = [...digest.subarray(0, 16)]
    .map((byte) => `${(byte >> 4).toString(16)}${(byte & 0x0f).toString(16)}`)
    .join("")
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)),
    );
  return { key, extensionId };
}

async function prepareExtensionCopy(source, destination, key, hostName) {
  await cp(source, destination, { recursive: true });
  const manifestPath = join(destination, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.key = key;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const workerPath = join(destination, "service-worker.js");
  const worker = await readFile(workerPath, "utf8");
  const sourceHost = '"com.pippin.native_host_dev"';
  assert.equal(worker.split(sourceHost).length - 1, 1, "built worker host binding changed");
  const patched = worker.replace(sourceHost, JSON.stringify(hostName));
  await writeFile(workerPath, addWorkerDiagnostics(patched), "utf8");
}

function addWorkerDiagnostics(worker) {
  const sites = [
    [
      "const native = await sendNativeBootstrap(identity);",
      "console.info('PIPPIN_CFT_DIAG:bootstrap-ok');",
    ],
    [
      "const reply = await authenticate(socket, hello);",
      "console.info('PIPPIN_CFT_DIAG:auth-' + (reply?.kind ?? 'none') + (reply?.code ? ':' + reply.code : ''));",
    ],
    [
      "await synchronizeBrowserInventory(socket, identity);",
      "console.info('PIPPIN_CFT_DIAG:inventory-ready');",
    ],
    [
      "connection.heartbeatTimer = globalThis.setInterval(() => {",
      "console.info('PIPPIN_CFT_DIAG:heartbeat-tick:' + Date.now());",
    ],
    ["if (heartbeat.success) {", "console.info('PIPPIN_CFT_DIAG:heartbeat-ack:' + Date.now());"],
    [
      "function dropExecutor(connection) {",
      "console.info('PIPPIN_CFT_DIAG:executor-drop:' + Date.now());",
    ],
    [
      'socket.addEventListener("close", () => dropExecutor(connection), { once: true });',
      'socket.addEventListener("close", (event) => { console.info("PIPPIN_CFT_DIAG:executor-close:" + event.code + ":" + event.reason + ":" + Date.now()); dropExecutor(connection); }, { once: true });',
    ],
  ];
  let result = worker;
  for (const [source, marker] of sites) {
    assert.equal(result.split(source).length - 1, 1, "temporary worker diagnostic site changed");
    result = result.replace(source, `${source}\n    ${marker}`);
  }
  return result;
}

export async function hasPippinProcess() {
  const script = `$p=Get-CimInstance Win32_Process | Where-Object { ($_.Name -ieq 'pippin-native-host.exe') -or (($_.Name -match '^node(\\.exe)?$') -and ($_.CommandLine -match 'apps[\\\\/]daemon[\\\\/]dist[\\\\/]main\\.js')) }; if ($p) { exit 0 } else { exit 1 }`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Could not check for an existing Pippin daemon");
}

async function hasNativeSupervisor(executablePath) {
  const literalPath = executablePath.replaceAll("'", "''");
  const script = `$p=Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'pippin-native-host.exe' -and $_.ExecutablePath -ieq '${literalPath}' -and $_.CommandLine -match '--daemon-supervisor' }; if ($p) { exit 0 } else { exit 1 }`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: "ignore" },
  );
  return result.status === 0;
}

export function queryRegistry(key) {
  return spawnSync("reg.exe", ["query", key], { windowsHide: true, stdio: "ignore" });
}
