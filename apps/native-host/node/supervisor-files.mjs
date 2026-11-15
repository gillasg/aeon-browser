import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 262144;
const MESSAGE_LIMIT = 2000;

/** Append-only supervisor log, best effort and never fatal, rotated at 256 KiB. */
export class SupervisorLog {
  constructor(path) {
    this.path = path;
    this.previous = path + ".previous";
  }

  write(message) {
    if (!message) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (existsSync(this.path) && statSync(this.path).size > MAX_LOG_BYTES) {
        rmSync(this.previous, { force: true });
        renameSync(this.path, this.previous);
      }
      appendFileSync(
        this.path,
        `${new Date().toISOString()} ${String(message).slice(0, MESSAGE_LIMIT)}\n`,
      );
    } catch {
      // A log that cannot be written must never change what the daemon does.
    }
  }
}

/** Best-effort progress file a watchdog/doctor reads to tell a working supervisor from a wedged one. */
export class SupervisorStatus {
  constructor(path) {
    this.path = path;
    this.supervisorPid = process.pid;
    this.startedAt = new Date().toISOString();
    this.state = "starting";
    this.phase = "spawn";
    this.daemonPid = 0;
    this.restarts = 0;
  }

  setPhase(phase) {
    this.state = "starting";
    this.phase = phase;
    this.daemonPid = 0;
    this.write();
  }

  setReady(pid) {
    this.state = "ready";
    this.phase = "";
    this.daemonPid = pid;
    this.write();
  }

  setRestarting(reason) {
    this.state = "restarting";
    this.phase = reason;
    this.daemonPid = 0;
    this.restarts += 1;
    this.write();
  }

  clear() {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Nothing to clear.
    }
  }

  read() {
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return undefined;
    }
  }

  write() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const value = {
        kind: "daemon-supervisor.status",
        supervisorPid: this.supervisorPid,
        daemonPid: this.daemonPid,
        state: this.state,
        phase: this.phase,
        startedAt: this.startedAt,
        updatedAt: new Date().toISOString(),
        restarts: this.restarts,
      };
      const temporary = this.path + ".tmp";
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // Status is diagnostic only.
    }
  }
}
