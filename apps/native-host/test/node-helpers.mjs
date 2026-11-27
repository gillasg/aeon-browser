import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appRoot, hostPaths } from "../node/paths.mjs";
import { readFrame, writeFrame } from "../node/frames.mjs";

export const hostEntry = fileURLToPath(new URL("../node/native-host.mjs", import.meta.url));
export const fixtureDaemon = fileURLToPath(new URL("./fixtures/fake-daemon.mjs", import.meta.url));
export const EXTENSION_ID = "a".repeat(32);
export const ORIGIN = "chrome-extension://" + EXTENSION_ID;

export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "graft-node-host-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = envFor(home);
  const app = appRoot({ env, platform: process.platform, home });
  const data = join(app, "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const config = join(app, "host-config.json");
  return {
    root,
    home,
    env,
    app,
    data,
    config,
    socket: hostPaths({ env, platform: process.platform, home }).socket,
  };
}

export function envFor(home, extra = {}) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    GRAFT_PHASE_TIMEOUT_MS: "1500",
    GRAFT_BOOTSTRAP_REPLY_MS: "400",
    GRAFT_HEALTH_WAIT_MS: "500",
    ...extra,
  };
  delete env.GRAFT_DATA_DIR;
  delete env.GRAFT_CORE_DATA_DIR;
  return env;
}

export function writeConfig(sandbox, options = {}) {
  const config = {
    extensionId: options.extensionId ?? EXTENSION_ID,
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    daemonEntrypoint: options.daemonEntrypoint ?? fixtureDaemon,
    dataDirectory: options.dataDirectory ?? sandbox.data,
  };
  mkdirSync(dirname(sandbox.config), { recursive: true });
  writeFileSync(sandbox.config, JSON.stringify(config));
  return config;
}

export async function startSupervisor(sandbox, env = {}) {
  const child = spawn(process.execPath, [hostEntry, "--daemon-supervisor"], {
    env: { ...sandbox.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await waitFor(() => existsSync(sandbox.socket), 8000);
  return { child, output: () => output };
}

/** Runs the native host exactly as Chrome does and returns its framed response. */
export async function nativeBootstrap(sandbox, request, options = {}) {
  const child = spawn(process.execPath, [hostEntry, options.origin ?? ORIGIN], {
    env: { ...sandbox.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const response = readFrame(child.stdout, { timeoutMs: options.timeoutMs ?? 15_000 });
  await writeFrame(child.stdin, Buffer.from(JSON.stringify(request), "utf8"));
  child.stdin.end();
  const frame = await response;
  const result = frame ? JSON.parse(frame.toString("utf8")) : undefined;
  await waitForExit(child, 5000);
  return { result, child };
}

export function bootstrapRequest() {
  return {
    kind: "native.bootstrap",
    protocolVersion: { major: 1, minor: 1 },
    clientInstanceId: "00000000-0000-4000-8000-000000000001",
    browserRunId: "00000000-0000-4000-8000-000000000002",
  };
}

export async function stopSupervisor(sandbox, env = {}) {
  const child = spawn(process.execPath, [hostEntry, "--stop-supervisor"], {
    env: { ...sandbox.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return waitForExit(child, 6000);
}

export function waitFor(predicate, timeoutMs, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) {
        resolve(undefined);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for a condition."));
        return;
      }
      setTimeout(tick, intervalMs).unref?.();
    };
    tick();
  });
}

export function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL" });
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export function readLog(sandbox) {
  try {
    return readFileSync(join(sandbox.app, "daemon-supervisor.log"), "utf8");
  } catch {
    return "";
  }
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export async function waitForReady(sandbox, timeoutMs = 10_000) {
  await waitFor(
    () => readJson(join(sandbox.app, "daemon-supervisor-status.json"))?.state === "ready",
    timeoutMs,
  );
}

export async function cleanup(sandbox, ...children) {
  for (const child of children) {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
  const pid = Number(readJson(join(sandbox.data, "fake-daemon-pid")) ?? 0);
  if (pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(sandbox.socket, { force: true });
  rmSync(sandbox.root, { recursive: true, force: true });
}
