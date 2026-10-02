import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const localAppData = process.env.LOCALAPPDATA;
assert.ok(localAppData, "LocalAppData is unavailable");
const appRoot = resolve(join(localAppData, "Pippin", "Slice3Dev"));
const configPath = join(appRoot, "host-config.json");
const nativeHost = join(repoRoot, "apps", "native-host", "dist", "pippin-native-host.exe");
const daemon = join(repoRoot, "apps", "daemon", "dist", "main.js");
const nodeRuntime = join(
  localAppData,
  "Temp",
  "pippin-node22.19-f6f3d3b89e1c4c4f8a17bf5b12537824",
  "node-v22.19.0-win-x64",
  "node.exe",
);
const probeRoot = join(appRoot, `managed-env-probe-${randomUUID().replaceAll("-", "")}`);
const dataDirectory = join(probeRoot, "data");
const agentDirectory = join(probeRoot, "pi-agent-config");
const daemonWrapper = join(probeRoot, "daemon-entry.mjs");
const markerPath = join(probeRoot, "inherited-environment.json");
const appPrefix = `${appRoot}${sep}`;
const sentinel = randomBytes(24).toString("base64url");
const priorConfig = await readFile(configPath);
const priorAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const priorSentinel = process.env.PIPPIN_NATIVE_PROBE_SENTINEL;
const pippinProcesses = await findPippinProcesses();
assert.equal(pippinProcesses, 0, "A Pippin native host or daemon is already running");
assert.equal(exists(nativeHost), true, "Build the native host before this probe");
assert.equal(exists(daemon), true, "Build the daemon before this probe");
assert.equal(exists(nodeRuntime), true, "The isolated Node 22 runtime is unavailable");
assert.ok(resolve(probeRoot).startsWith(appPrefix));

let child;
let nativeResponse;
let processExitCode;
let timedOut = false;
try {
  await mkdir(probeRoot, { recursive: false });
  await mkdir(dataDirectory, { recursive: false });
  await mkdir(agentDirectory, { recursive: false });
  const wrapper = [
    'import { writeFile } from "node:fs/promises";',
    'import { writeFileSync } from "node:fs";',
    `const inherited = process.env.PIPPIN_NATIVE_PROBE_SENTINEL === ${JSON.stringify(sentinel)} && process.env.PI_CODING_AGENT_DIR === ${JSON.stringify(agentDirectory)};`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    'await writeFile(markerPath, JSON.stringify({ inherited, daemonReady: false }), "utf8");',
    'if (!inherited) { console.error("NATIVE_ENV_PROBE_FAILED"); process.exit(78); }',
    "const originalWrite = process.stdout.write.bind(process.stdout);",
    "process.stdout.write = (chunk, ...args) => {",
    '  if (String(chunk).includes("PIPPIN_DAEMON_READY")) writeFileSync(markerPath, JSON.stringify({ inherited, daemonReady: true }), "utf8");',
    "  return originalWrite(chunk, ...args);",
    "};",
    `await import(${JSON.stringify(pathToFileURL(daemon).href)});`,
    "",
  ].join("\n");
  await writeFile(daemonWrapper, wrapper, "utf8");

  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  process.env.PIPPIN_NATIVE_PROBE_SENTINEL = sentinel;
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        extensionId: createExtensionId(),
        nodeExecutable: nodeRuntime,
        daemonEntrypoint: daemonWrapper,
        dataDirectory,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const request = Buffer.from(
    JSON.stringify({
      kind: "native.bootstrap",
      protocolVersion: { major: 1, minor: 2 },
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
    }),
    "utf8",
  );
  const frame = Buffer.alloc(4 + request.length);
  frame.writeInt32LE(request.length, 0);
  request.copy(frame, 4);
  const extensionId = JSON.parse(await readFile(configPath, "utf8")).extensionId;
  const loginStartupVerified = process.argv.includes("--login-startup")
    ? await exerciseLoginStartup(nativeHost, markerPath)
    : false;
  child = spawn(nativeHost, [`chrome-extension://${extensionId}/`], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stdin.end(frame);
  let timeoutHandle;
  try {
    processExitCode = await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", resolveExit);
      }),
      new Promise((_, rejectTimeout) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill();
          rejectTimeout(new Error("Native host environment probe timed out"));
        }, 60_000);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  const bytes = Buffer.concat(output);
  assert.ok(bytes.length >= 4, "Native host returned no framed response");
  const payloadSize = bytes.readInt32LE(0);
  assert.equal(bytes.length, payloadSize + 4, "Native host response frame length is invalid");
  nativeResponse = JSON.parse(bytes.subarray(4).toString("utf8"));
  const marker = await readFile(markerPath, "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => ({ inherited: false }));
  const result = {
    nativeHostExitCode: processExitCode,
    managedDaemonReady: nativeResponse.ok === true,
    environmentInherited: marker.inherited === true,
    daemonProtocolVersion: nativeResponse.ok === true ? nativeResponse.daemonProtocolVersion : null,
    credentialOrPromptLogged: false,
    loginStartupVerified,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  assert.equal(result.managedDaemonReady, true, "Managed daemon did not complete native bootstrap");
  assert.equal(
    result.environmentInherited,
    true,
    "Native supervisor did not inherit the fixture environment",
  );
} catch (error) {
  const marker = await readFile(markerPath, "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => ({ inherited: false, daemonReady: false }));
  process.stdout.write(
    `${JSON.stringify({
      timedOut,
      daemonStartedWithFixtureEnvironment: marker.inherited,
      managedDaemonReady: marker.daemonReady,
      credentialOrPromptLogged: false,
    })}\n`,
  );
  throw error;
} finally {
  if (child && child.exitCode === null) child.kill();
  spawnSync(nativeHost, ["--stop-supervisor"], {
    windowsHide: true,
    timeout: 10_000,
    stdio: "ignore",
  });
  restoreEnvironment("PI_CODING_AGENT_DIR", priorAgentDirectory);
  restoreEnvironment("PIPPIN_NATIVE_PROBE_SENTINEL", priorSentinel);
  await writeFile(configPath, priorConfig);
  await delay(500);
  const target = resolve(probeRoot);
  assert.ok(target.startsWith(appPrefix) && target.includes("managed-env-probe-"));
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

function createExtensionId() {
  return [...randomBytes(16)]
    .map((byte) => `${(byte >> 4).toString(16)}${(byte & 0x0f).toString(16)}`)
    .join("")
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)),
    );
}

function exists(path) {
  return existsSync(path);
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function findPippinProcesses() {
  const script =
    "$p=Get-CimInstance Win32_Process | Where-Object { ($_.Name -ieq 'pippin-native-host.exe') -or (($_.Name -match '^node(\\.exe)?$') -and ($_.CommandLine -match 'apps[\\\\/]daemon[\\\\/]dist[\\\\/]main\\.js')) }; if ($p) { exit 0 } else { exit 1 }";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: "ignore" },
  );
  if (result.status === 0) return 1;
  if (result.status === 1) return 0;
  throw new Error("Could not check for an existing Pippin process");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function exerciseLoginStartup(host, markerPath) {
  const supervisor = spawn(host, ["--daemon-supervisor"], { windowsHide: true, stdio: "ignore" });
  supervisor.unref();
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await readFile(markerPath, "utf8")
      .then((text) => JSON.parse(text).daemonReady === true)
      .catch(() => false);
    if (ready) break;
    await delay(100);
  }
  assert.equal(ready, true, "Login supervisor did not start the daemon without Chrome");
  const duplicate = spawn(host, ["--daemon-supervisor"], { windowsHide: true, stdio: "ignore" });
  const code = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      duplicate.kill();
      rejectExit(new Error("Duplicate startup did not exit"));
    }, 5000);
    duplicate.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    duplicate.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  assert.equal(code, 0, "The second login launcher did not reuse the singleton");
  return true;
}
