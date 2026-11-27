import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ensureSupervisor } from "../node/host.mjs";
import { serviceFile, serviceState, startService } from "../node/service-state.mjs";

function sandbox(platform = "linux") {
  const root = mkdtempSync(join(tmpdir(), "graft-service-"));
  const home = join(root, "home");
  const env = { XDG_CONFIG_HOME: join(home, ".config") };
  const options = { platform, home, env, uid: 501 };
  const file = serviceFile(options);
  const log = [];
  return {
    root,
    file,
    options,
    log,
    logger: { write: (line) => log.push(line) },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeServiceFile(box) {
  mkdirSync(dirname(box.file), { recursive: true });
  writeFileSync(box.file, "unit");
}

const child = () => ({ on: () => undefined, unref: () => undefined });

test("an installed but stopped service is asked to start, not raced with a second supervisor", () => {
  const box = sandbox();
  try {
    writeServiceFile(box);
    let started = 0;
    let spawned = 0;
    const outcome = ensureSupervisor({ nodeExecutable: process.execPath }, box.logger, {
      serviceState: () => "inactive",
      startService: () => {
        started += 1;
        return true;
      },
      spawn: () => {
        spawned += 1;
        return child();
      },
    });
    assert.equal(outcome, "service");
    assert.equal(started, 1);
    assert.equal(spawned, 0);
    assert.match(box.log.join("\n"), /installed but not running/);
  } finally {
    box.cleanup();
  }
});

test("a running service is left alone", () => {
  const box = sandbox();
  try {
    writeServiceFile(box);
    let started = 0;
    let spawned = 0;
    const outcome = ensureSupervisor({ nodeExecutable: process.execPath }, box.logger, {
      serviceState: () => "active",
      startService: () => {
        started += 1;
        return true;
      },
      spawn: () => {
        spawned += 1;
        return child();
      },
    });
    assert.equal(outcome, "service");
    assert.equal(started, 0);
    assert.equal(spawned, 0);
  } finally {
    box.cleanup();
  }
});

test("a service that refuses to start still gets a supervisor, and no unit means a direct one", () => {
  const box = sandbox();
  try {
    writeServiceFile(box);
    let spawned = 0;
    const spawn = () => {
      spawned += 1;
      return child();
    };
    const failed = ensureSupervisor({ nodeExecutable: process.execPath }, box.logger, {
      serviceState: () => "inactive",
      startService: () => false,
      spawn,
    });
    assert.equal(failed, "manual");
    assert.equal(spawned, 1);
    assert.match(box.log.join("\n"), /did not start/);

    const absent = ensureSupervisor({ nodeExecutable: process.execPath }, box.logger, {
      serviceState: () => "absent",
      startService: () => {
        throw new Error("must not be asked");
      },
      spawn,
    });
    assert.equal(absent, "manual");
    assert.equal(spawned, 2);
  } finally {
    box.cleanup();
  }
});

test("the state probe asks systemd whether the unit is active", () => {
  const box = sandbox();
  try {
    const missing = serviceState({
      ...box.options,
      exec: () => {
        throw new Error("must not run without a unit file");
      },
    });
    assert.equal(missing, "absent");
    writeServiceFile(box);
    const calls = [];
    const state = serviceState({
      ...box.options,
      exec: (file, args) => {
        calls.push([file, ...args]);
        if (file === "systemctl") return;
        throw new Error("inactive");
      },
    });
    assert.equal(state, "active");
    assert.deepEqual(calls, [
      ["systemctl", "--user", "is-active", "--quiet", "graft-daemon.service"],
    ]);
    const stopped = serviceState({
      ...box.options,
      exec: () => {
        throw new Error("inactive");
      },
    });
    assert.equal(stopped, "inactive");
  } finally {
    box.cleanup();
  }
});

test("starting clears a start limit first, and macOS kickstarts the agent", () => {
  const linux = sandbox();
  try {
    writeServiceFile(linux);
    const calls = [];
    const started = startService({
      ...linux.options,
      exec: (file, args) => calls.push([file, ...args]),
    });
    assert.equal(started, true);
    assert.deepEqual(calls, [
      ["systemctl", "--user", "reset-failed", "graft-daemon.service"],
      ["systemctl", "--user", "start", "graft-daemon.service"],
    ]);
  } finally {
    linux.cleanup();
  }

  const mac = sandbox("darwin");
  try {
    writeServiceFile(mac);
    const stateCalls = [];
    const state = serviceState({
      ...mac.options,
      exec: (file, args) => {
        stateCalls.push([file, ...args]);
        throw new Error("not loaded");
      },
    });
    assert.equal(state, "inactive");
    assert.deepEqual(stateCalls, [["launchctl", "print", "gui/501/com.graft.daemon"]]);
    const startCalls = [];
    const started = startService({
      ...mac.options,
      exec: (file, args) => startCalls.push([file, ...args]),
    });
    assert.equal(started, true);
    assert.deepEqual(startCalls, [["launchctl", "kickstart", "-k", "gui/501/com.graft.daemon"]]);
  } finally {
    mac.cleanup();
  }
});
