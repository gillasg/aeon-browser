import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const localAppData = process.env.LOCALAPPDATA;
assert.ok(localAppData);
const appRoot = join(localAppData, "Pippin", "Slice3Dev");
const dataPath = join(appRoot, `slice4-daemon-startup-${randomUUID().replaceAll("-", "")}`);
const appPrefix = `${resolve(appRoot)}${sep}`;
assert.ok(resolve(dataPath).startsWith(appPrefix));
const runtime = join(
  tmpdir(),
  "pippin-node22.19-f6f3d3b89e1c4c4f8a17bf5b12537824",
  "node-v22.19.0-win-x64",
  "node.exe",
);
const daemon = join(root, "apps", "daemon", "dist", "main.js");
let child;
let errorOutput = "";

try {
  await mkdir(dataPath, { recursive: false });
  child = spawn(runtime, [daemon, "--managed-daemon"], {
    cwd: dataPath,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PIPPIN_NATIVE_DATA_DIR: dataPath,
      PIPPIN_NATIVE_EXTENSION_ORIGIN: "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh",
      PIPPIN_NATIVE_SUPERVISED: "1",
    },
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (errorOutput.length < 2048) errorOutput += String(chunk).slice(0, 2048 - errorOutput.length);
  });
  const result = await Promise.race([
    new Promise((resolveResult) => {
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        pending += chunk;
        if (pending.includes("PIPPIN_DAEMON_READY"))
          resolveResult({ ready: true, exitCode: undefined });
      });
      child.once("error", () => resolveResult({ ready: false, exitCode: -1 }));
      child.once("exit", (exitCode) => resolveResult({ ready: false, exitCode }));
    }),
    new Promise((resolveResult) =>
      setTimeout(() => resolveResult({ ready: false, exitCode: "timeout" }), 20_000),
    ),
  ]);
  if (result.ready) {
    child.stdin.write("shutdown\n");
    await Promise.race([onceExit(child), delay(5000)]);
  } else if (child.exitCode === null) {
    child.kill();
    await Promise.race([onceExit(child), delay(5000)]);
  }
  process.stdout.write(
    JSON.stringify({
      daemonReady: result.ready,
      exitCode: result.exitCode,
      failureClass: result.ready ? undefined : classify(errorOutput),
      node: process.versions.node,
    }) + "\n",
  );
} finally {
  if (child && child.exitCode === null) child.kill();
  const target = resolve(dataPath);
  assert.ok(target.startsWith(appPrefix) && target.includes("slice4-daemon-startup-"));
  await rm(target, { recursive: true, force: true });
}

function onceExit(processHandle) {
  return new Promise((resolveExit) => processHandle.once("exit", resolveExit));
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function classify(output) {
  if (output.includes("NODE_MODULE_VERSION")) return "NATIVE_MODULE_ABI_MISMATCH";
  if (output.includes("Cannot find module")) return "MODULE_NOT_FOUND";
  if (output.includes("PIPPIN_NATIVE_SUPERVISED")) return "MISSING_SUPERVISOR_ENV";
  return output ? "DAEMON_STARTUP_ERROR" : "NO_READY_MARKER";
}
