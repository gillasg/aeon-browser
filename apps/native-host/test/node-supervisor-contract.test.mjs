import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  bootstrapRequest,
  cleanup,
  createSandbox,
  nativeBootstrap,
  ORIGIN,
  readJson,
  readLog,
  startSupervisor,
  stopSupervisor,
  waitFor,
  waitForReady,
  writeConfig,
} from "./node-helpers.mjs";

test(
  "a bootstrap reaches the daemon through the host and supervisor",
  { timeout: 25_000, skip: process.platform === "win32" ? "Mac/Linux Node host" : false },
  async () => {
    const sandbox = createSandbox();
    writeConfig(sandbox);
    const supervisor = await startSupervisor(sandbox, { FAKE_DAEMON_MODE: "normal" });
    try {
      await waitForReady(sandbox);
      const { result } = await nativeBootstrap(sandbox, bootstrapRequest());
      assert.equal(result.ok, true);
      assert.equal(result.echo, ORIGIN);
      const status = readJson(join(sandbox.app, "daemon-supervisor-status.json"));
      assert.equal(status.state, "ready");
      assert.ok(status.daemonPid > 0);
      assert.equal(readLog(sandbox).includes("Daemon ready"), true);
    } finally {
      const stopped = await stopSupervisor(sandbox);
      assert.equal(stopped.code, 0);
      const exit = await waitForExitOrKill(supervisor.child);
      assert.equal(exit.code, 0);
      await cleanup(sandbox, supervisor.child);
    }
  },
);

test(
  "a daemon that misses one bootstrap but answers health is kept",
  { timeout: 25_000, skip: process.platform === "win32" ? "Mac/Linux Node host" : false },
  async () => {
    const sandbox = createSandbox();
    writeConfig(sandbox);
    const supervisor = await startSupervisor(sandbox, { FAKE_DAEMON_MODE: "health-only" });
    try {
      await waitForReady(sandbox);
      const before = readJson(join(sandbox.app, "daemon-supervisor-status.json")).daemonPid;
      const { result } = await nativeBootstrap(sandbox, bootstrapRequest());
      assert.equal(result.ok, false);
      assert.equal(result.code, "BOOTSTRAP_UNAVAILABLE");
      assert.equal(result.retryable, true);
      const after = readJson(join(sandbox.app, "daemon-supervisor-status.json"));
      assert.equal(after.state, "ready");
      assert.equal(after.daemonPid, before);
      assert.match(readLog(sandbox), /answered the health ping; kept running/);
    } finally {
      await stopSupervisor(sandbox);
      await cleanup(sandbox, supervisor.child);
    }
  },
);

test(
  "a daemon silent to bootstrap and health is replaced",
  { timeout: 30_000, skip: process.platform === "win32" ? "Mac/Linux Node host" : false },
  async () => {
    const sandbox = createSandbox();
    writeConfig(sandbox);
    const supervisor = await startSupervisor(sandbox, { FAKE_DAEMON_MODE: "silent" });
    try {
      await waitForReady(sandbox);
      const { result } = await nativeBootstrap(sandbox, bootstrapRequest());
      assert.equal(result.ok, false);
      assert.equal(result.code, "DAEMON_OFFLINE");
      assert.equal(result.retryable, true);
      await waitFor(() => starts(sandbox) >= 2, 10_000);
      assert.match(readLog(sandbox), /no bootstrap reply and no health ping/);
    } finally {
      await stopSupervisor(sandbox);
      await cleanup(sandbox, supervisor.child);
    }
  },
);

test(
  "a daemon that crashes after serving is restarted and serves again",
  { timeout: 30_000, skip: process.platform === "win32" ? "Mac/Linux Node host" : false },
  async () => {
    const sandbox = createSandbox();
    writeConfig(sandbox);
    const supervisor = await startSupervisor(sandbox, { FAKE_DAEMON_MODE: "crash-after-reply" });
    try {
      await waitForReady(sandbox);
      const first = await nativeBootstrap(sandbox, bootstrapRequest());
      assert.equal(first.result.ok, true);
      await waitFor(() => starts(sandbox) >= 2, 10_000);
      await waitForReady(sandbox);
      const second = await nativeBootstrap(sandbox, bootstrapRequest());
      assert.equal(second.result.ok, true);
      assert.match(readLog(sandbox), /Daemon exited, code 3/);
    } finally {
      await stopSupervisor(sandbox);
      await cleanup(sandbox, supervisor.child);
    }
  },
);

test(
  "a daemon that exits or stalls during startup is replaced",
  { timeout: 30_000, skip: process.platform === "win32" ? "Mac/Linux Node host" : false },
  async () => {
    const exiting = createSandbox();
    writeConfig(exiting);
    const first = await startSupervisor(exiting, {
      FAKE_DAEMON_MODE: "exit-immediately",
      GRAFT_PHASE_TIMEOUT_MS: "1500",
    });
    try {
      await waitFor(() => starts(exiting) >= 2, 10_000);
      assert.match(readLog(exiting), /Daemon restarting: daemon output closed during initialize/);
    } finally {
      await stopSupervisor(exiting);
      await cleanup(exiting, first.child);
    }

    const stalling = createSandbox();
    writeConfig(stalling);
    const second = await startSupervisor(stalling, {
      FAKE_DAEMON_MODE: "stall",
      GRAFT_PHASE_TIMEOUT_MS: "300",
    });
    try {
      await waitFor(() => starts(stalling) >= 2, 10_000);
      assert.match(readLog(stalling), /daemon startup stalled during/);
    } finally {
      await stopSupervisor(stalling);
      await cleanup(stalling, second.child);
    }
  },
);

test(
  "a daemon that reports phases forever still hits an overall boot budget",
  { timeout: 25_000, skip: process.platform === "win32" ? "Mac/Linux Node host" : false },
  async () => {
    const sandbox = createSandbox();
    writeConfig(sandbox);
    const supervisor = await startSupervisor(sandbox, {
      FAKE_DAEMON_MODE: "phase-forever",
      GRAFT_PHASE_TIMEOUT_MS: "5000", // per-phase never fires: lines keep resetting it
      GRAFT_BOOT_TIMEOUT_MS: "400",
    });
    try {
      await waitFor(() => starts(sandbox) >= 2, 10_000);
      assert.match(readLog(sandbox), /boot-timeout: daemon did not become ready within 400ms/);
    } finally {
      await stopSupervisor(sandbox);
      await cleanup(sandbox, supervisor.child);
    }
  },
);

test(
  "a foreign origin is refused before any supervisor starts",
  { timeout: 15_000, skip: process.platform === "win32" ? "Mac/Linux Node host" : false },
  async () => {
    const sandbox = createSandbox();
    writeConfig(sandbox);
    try {
      const { result } = await nativeBootstrap(sandbox, bootstrapRequest(), {
        origin: "chrome-extension://" + "b".repeat(32),
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ORIGIN_NOT_ALLOWED");
      assert.equal(result.retryable, false);
      assert.equal(starts(sandbox), 0);
    } finally {
      await cleanup(sandbox);
    }
  },
);

function starts(sandbox) {
  try {
    return readFileSync(join(sandbox.data, "fake-daemon-starts"), "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

function waitForExitOrKill(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null });
    }, 8000);
    timer.unref?.();
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}
