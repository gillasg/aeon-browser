import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const localAppData = process.env.LOCALAPPDATA;
assert.ok(localAppData);
const appRoot = join(localAppData, "Pippin", "Slice3Dev");
const configPath = join(appRoot, "host-config.json");
const configBefore = await readFile(configPath);
const dataPath = join(appRoot, `slice4-native-host-${randomUUID().replaceAll("-", "")}`);
const priorProbePath = join(appRoot, "slice4-native-host-ee37379a7a2840cfb316d1a7a9f6910e");
const appPrefix = `${resolve(appRoot)}${sep}`;
const nodeRuntime = join(
  localAppData,
  "Temp",
  "pippin-node22.19-f6f3d3b89e1c4c4f8a17bf5b12537824",
  "node-v22.19.0-win-x64",
  "node.exe",
);
const daemon = join(root, "apps", "daemon", "dist", "main.js");
const nativeHost = join(root, "apps", "native-host", "dist", "pippin-native-host.exe");
const extensionId = [...randomBytes(16)]
  .map((byte) => `${(byte >> 4).toString(16)}${(byte & 0x0f).toString(16)}`)
  .join("")
  .replace(/[0-9a-f]/g, (digit) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)),
  );
const stopSupervisor = () =>
  spawnSync(nativeHost, ["--stop-supervisor"], { windowsHide: true, timeout: 5000 });

let child;
try {
  assert.ok(resolve(dataPath).startsWith(appPrefix));
  await mkdir(dataPath, { recursive: false });
  await writeFile(
    configPath,
    `${JSON.stringify({ extensionId, nodeExecutable: nodeRuntime, daemonEntrypoint: daemon, dataDirectory: dataPath }, null, 2)}\n`,
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
  child = spawn(nativeHost, [`chrome-extension://${extensionId}/`], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stdin.end(frame);
  let timeout;
  const exit = await Promise.race([
    new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code));
    }),
    new Promise((resolveTimeout, rejectTimeout) => {
      timeout = setTimeout(() => {
        child.kill();
        rejectTimeout(new Error("native bootstrap probe timed out"));
      }, 30_000);
    }),
  ]);
  clearTimeout(timeout);
  const bytes = Buffer.concat(output);
  assert.ok(bytes.length >= 4);
  const payloadSize = bytes.readInt32LE(0);
  assert.equal(bytes.length, payloadSize + 4);
  const response = JSON.parse(bytes.subarray(4).toString("utf8"));
  process.stdout.write(
    JSON.stringify({
      processExitCode: exit,
      bootstrapOk: response.ok === true,
      bootstrapCode: response.ok === false ? response.code : undefined,
      daemonProtocolVersion: response.ok === true ? response.daemonProtocolVersion : undefined,
      promptOrCredentialLogged: false,
    }) + "\n",
  );
} finally {
  if (child && child.exitCode === null) child.kill();
  stopSupervisor();
  await writeFile(configPath, configBefore);
  await delay(1000);
  for (const path of [dataPath, priorProbePath]) {
    const target = resolve(path);
    assert.ok(target.startsWith(appPrefix) && target.includes("slice4-native-host-"));
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
