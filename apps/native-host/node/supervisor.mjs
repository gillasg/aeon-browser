import { spawn } from "node:child_process";
import { chmodSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { ensureSocketDirectory, hostPaths, socketOwnerProblem } from "./paths.mjs";
import { loadConfig } from "./config.mjs";
import { createLineReader } from "./line-reader.mjs";
import { startupFailureMessage, SupervisorLog, SupervisorStatus } from "./supervisor-files.mjs";
import { corePing } from "./health.mjs";
import { readFrame, writeFrame } from "./frames.mjs";
import {
  failure,
  healthRequestLine,
  isAliveAnswer,
  isBase64,
  isStopRequest,
  phaseOf,
  readEnvelope,
  restartDelay,
} from "./protocol.mjs";

const PHASE_TIMEOUT_MS = numberEnv("GRAFT_PHASE_TIMEOUT_MS", 90_000);
// A per-phase deadline is not enough: a daemon that keeps emitting phase lines (or a loop of
// them) resets it forever and the supervisor never leaves "starting". This overall budget bounds
// the whole boot no matter how many phases it reports.
const BOOT_TIMEOUT_MS = numberEnv("GRAFT_BOOT_TIMEOUT_MS", 180_000);
const SPAWN_TIMEOUT_MS = 90_000;
const HEALTH_WAIT_MS = numberEnv("GRAFT_HEALTH_WAIT_MS", 2500);
const BOOTSTRAP_REPLY_MS = numberEnv("GRAFT_BOOTSTRAP_REPLY_MS", 15_000);
const CLIENT_READ_MS = 5000;
const SHUTDOWN_WAIT_MS = 5000;

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class StopRequested extends Error {}

/** Runs the daemon supervisor until it is stopped. Returns the process exit code. */
export async function runSupervisor(options = {}) {
  const paths = hostPaths(options);
  const log = new SupervisorLog(paths.log);
  let config;
  try {
    config = await loadConfig(options.configPath ?? paths.config);
  } catch (error) {
    log.write("Configuration failed: " + error.message);
    return 1;
  }
  config.extensionOrigin = "chrome-extension://" + config.extensionId;
  const supervisor = new Supervisor({ config, paths, log });
  return supervisor.run();
}

class Supervisor {
  constructor({ config, paths, log }) {
    this.config = config;
    this.paths = paths;
    this.log = log;
    this.status = new SupervisorStatus(paths.status);
    this.server = net.createServer((socket) => this.enqueue(socket));
    this.pending = Promise.resolve();
    this.session = undefined;
    this.stopping = false;
    this.stopPromise = new Promise((resolve) => {
      this.stopSignal = resolve;
    });
    this.exitReason = undefined;
    this.signals = ["SIGTERM", "SIGINT"].map((signal) => {
      const handler = () => this.requestStop("signal");
      process.once(signal, handler);
      return [signal, handler];
    });
  }

  async run() {
    const bound = await this.bind();
    if (bound === "refused") return 1;
    if (bound === "duplicate") return 0;
    this.status.write();
    this.log.write(`Supervisor started, process ${process.pid}, socket ${this.paths.socket}`);
    try {
      await this.restartForever();
    } finally {
      await this.close();
    }
    return 0;
  }

  enqueue(socket) {
    this.pending = this.pending
      .then(() => this.handleClient(socket))
      .catch((error) => this.log.write("Client failed: " + error.message));
  }

  /** "ok" bound here, "duplicate" another supervisor of this user owns it, "refused" unsafe. */
  async bind() {
    try {
      ensureSocketDirectory(dirname(this.paths.socket));
    } catch (error) {
      this.log.write("Bootstrap socket refused: " + error.message);
      return "refused";
    }
    // A restrictive umask closes the window between listen() and chmod(): the socket is never
    // created with group or other access, even if our chmod fails.
    const prior = process.platform === "win32" ? undefined : process.umask(0o077);
    let state;
    try {
      state = await this.listenOnSocket();
    } finally {
      if (prior !== undefined) process.umask(prior);
    }
    if (state !== "ok") return state;
    chmodSync(this.paths.socket, 0o600);
    this.socketIdentity = statSync(this.paths.socket);
    this.server.on("error", (error) => this.log.write("Bootstrap socket: " + error.message));
    return "ok";
  }

  async listenOnSocket() {
    try {
      await listen(this.server, this.paths.socket);
      return "ok";
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      const problem = socketOwnerProblem(this.paths.socket);
      if (problem) {
        this.log.write("Bootstrap socket refused: " + problem);
        return "refused";
      }
      if (await canConnect(this.paths.socket)) {
        this.log.write("Another supervisor already owns the daemon.");
        return "duplicate";
      }
      try {
        unlinkSync(this.paths.socket);
      } catch {
        // Another process removed the stale socket first.
      }
      await listen(this.server, this.paths.socket);
      return "ok";
    }
  }

  async restartForever() {
    let failures = 0;
    while (!this.stopping) {
      const outcome = await this.runOnce();
      if (outcome === "stopped") return;
      failures = outcome === "crashed" ? 0 : failures + 1;
      const delay = restartDelay(failures);
      this.log.write(`Daemon restart in ${delay}ms.`);
      await this.sleep(delay);
    }
  }

  async runOnce() {
    let child;
    try {
      this.exitReason = undefined;
      this.status.setPhase("spawn");
      child = await this.spawnDaemon();
      const lines = createLineReader(child.stdout);
      this.session = { child, lines };
      await this.waitForReady(child, lines);
      this.status.setReady(child.pid);
      this.log.write(`Daemon ready, process ${child.pid}`);
      return await this.serve(child);
    } catch (error) {
      if (error instanceof StopRequested || this.stopping) return "stopped";
      const message = error instanceof Error ? error.message : String(error);
      this.log.write("Daemon restarting: " + message);
      const reason = error && typeof error === "object" ? error.reason : undefined;
      this.status.setRestarting(reason ?? "startup-failed", message);
      return "never-started";
    } finally {
      await this.finishSession(child);
    }
  }

  async spawnDaemon() {
    const child = spawn(
      this.config.nodeExecutable,
      [this.config.daemonEntrypoint, "--managed-daemon"],
      {
        cwd: this.config.dataDirectory,
        env: {
          ...process.env,
          GRAFT_NATIVE_DATA_DIR: this.config.dataDirectory,
          GRAFT_NATIVE_EXTENSION_ORIGIN: this.config.extensionOrigin,
          GRAFT_NATIVE_SUPERVISED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdin.on("error", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.log.write(String(chunk).trimEnd()));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(named("spawn-timeout", "spawn did not return.")),
        SPAWN_TIMEOUT_MS,
      );
      timer.unref?.();
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(named("startup-exited", error.message));
      });
    });
    return child;
  }

  async waitForReady(child, lines) {
    let phase = "spawn";
    let deadline = Date.now() + PHASE_TIMEOUT_MS;
    const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
    while (true) {
      if (Date.now() >= bootDeadline)
        throw named(
          "boot-timeout",
          `boot-timeout: daemon did not become ready within ${BOOT_TIMEOUT_MS}ms`,
        );
      const result = await this.waitOrStop(lines.next(Math.max(0, deadline - Date.now())));
      if (result.kind === "line") {
        if (result.line === "GRAFT_DAEMON_READY") return;
        const failed = startupFailureMessage(result.line);
        if (failed) throw named("startup-failed", failed);
        const next = phaseOf(result.line);
        if (next) {
          phase = next;
          deadline = Date.now() + PHASE_TIMEOUT_MS;
          this.status.setPhase(phase);
          this.log.write("Daemon phase " + phase);
        }
        continue;
      }
      if (result.kind === "eof")
        throw named(
          "startup-exited",
          `daemon output closed during ${phase}, code ${exitCodeOf(child)}`,
        );
      if (Date.now() >= deadline)
        throw named("startup-stalled", `daemon startup stalled during ${phase}`);
      if (child.exitCode !== null) throw named("startup-exited", `daemon exited during ${phase}`);
    }
  }

  waitOrStop(pending) {
    return Promise.race([
      pending,
      this.stopPromise.then(() => {
        throw new StopRequested("stop requested");
      }),
    ]);
  }

  async serve(child) {
    const exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.log.write(`Daemon exited, code ${code ?? signal ?? "unknown"}`);
        resolve();
      });
    });
    await Promise.race([exited, this.stopPromise]);
    if (this.stopping) return "stopped";
    const reason = this.exitReason ?? "daemon-exited";
    this.status.setRestarting(reason, `The daemon exited (${reason}).`);
    return "crashed";
  }

  async handleClient(socket) {
    socket.on("error", () => undefined);
    try {
      const frame = await readFrame(socket, { timeoutMs: CLIENT_READ_MS });
      if (!frame) return;
      const candidate = parseJson(frame);
      if (isStopRequest(candidate)) {
        await this.handleStop(socket);
        return;
      }
      await this.handleBootstrap(socket, candidate);
    } finally {
      socket.end();
    }
  }

  async handleStop(socket) {
    this.log.write("Stop requested.");
    await writeFrame(socket, Buffer.from('{"kind":"supervisor.stopped"}', "utf8"));
    socket.end();
    this.requestStop("stop");
  }

  async handleBootstrap(socket, candidate) {
    const request = readEnvelope(candidate, this.config.extensionOrigin);
    if (typeof request === "string") {
      await writeFrame(socket, failure(request, false));
      return;
    }
    const session = this.session;
    if (!session || !session.child.stdin.writable) {
      await writeFrame(socket, failure("DAEMON_OFFLINE", true));
      return;
    }
    await this.forward(socket, session, candidate);
  }

  async forward(socket, session, candidate) {
    let response;
    try {
      response = await this.bootstrapResponse(session, candidate);
    } catch (error) {
      if (error instanceof StopRequested) throw error;
      this.log.write("Daemon restart: bootstrap failed: " + error.message);
      this.poison(session.child, "bootstrap-error");
      response = failure("BOOTSTRAP_UNAVAILABLE", true);
    }
    // Chrome's extension retries after 10 s; a client that gave up must not turn a healthy daemon
    // into a restart.
    await writeFrame(socket, response).catch(() => undefined);
  }

  async bootstrapResponse(session, candidate) {
    const envelope = Buffer.from(JSON.stringify(candidate), "utf8");
    session.child.stdin.write(envelope.toString("base64") + "\n");
    const reply = await this.readReply(session.lines);
    if (reply === null) {
      if (await this.resynced(session)) {
        this.log.write(
          "Daemon missed one bootstrap reply but answered the health ping; kept running.",
        );
        return failure("BOOTSTRAP_UNAVAILABLE", true);
      }
      this.log.write("Daemon restart: no bootstrap reply and no health ping.");
      this.poison(session.child, "bootstrap-no-reply");
      return failure("DAEMON_OFFLINE", true);
    }
    const response = Buffer.from(reply, "base64");
    if (response.length === 0 || response.length > 16384) {
      this.log.write(`Daemon restart: bootstrap reply of ${response.length} bytes.`);
      this.poison(session.child, "bootstrap-reply-too-large");
      return failure("BOOTSTRAP_UNAVAILABLE", true);
    }
    return response;
  }

  async readReply(lines) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await this.waitOrStop(lines.next(BOOTSTRAP_REPLY_MS));
      if (result.kind !== "line") return null;
      if (!result.line.trim()) return null;
      if (phaseOf(result.line) === undefined && isBase64(result.line)) return result.line;
      if (phaseOf(result.line) === undefined)
        this.log.write("Daemon wrote a stray stdout line: " + result.line.slice(0, 160));
    }
    return null;
  }

  async resynced(session) {
    const ping = await corePing(this.config.dataDirectory);
    const pingKills = process.env.GRAFT_PING_KILLS === "1";
    this.log.write(
      `core.ping ${ping ? "answered" : "silent"}${pingKills ? "; kill uses core.ping (GRAFT_PING_KILLS=1)." : "; the kill still uses the stdout probe."}`,
    );
    if (pingKills) return ping;
    if (!this.askHealth(session.child)) return false;
    return this.healthAnswered(session.lines, Date.now() + HEALTH_WAIT_MS);
  }

  askHealth(child) {
    try {
      if (!child.stdin.writable) return false;
      child.stdin.write(healthRequestLine() + "\n");
      return true;
    } catch {
      return false;
    }
  }

  async healthAnswered(lines, deadline) {
    while (Date.now() < deadline) {
      const result = await this.waitOrStop(lines.next(deadline - Date.now()));
      if (result.kind !== "line" || !result.line) return false;
      if (isAliveAnswer(result.line)) return true;
    }
    return false;
  }

  poison(child, reason) {
    this.exitReason = reason;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  async finishSession(child) {
    this.session = undefined;
    if (!child) return;
    if (this.stopping) await shutdownChild(child, this.log);
    else {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    child.unref();
  }

  requestStop(reason) {
    if (this.stopping) return;
    this.stopping = true;
    this.log.write(`Supervisor stopping (${reason}).`);
    this.stopSignal();
  }

  async close() {
    await new Promise((resolve) => this.server.close(() => resolve()));
    await this.pending.catch(() => undefined);
    for (const [signal, handler] of this.signals) process.off(signal, handler);
    try {
      // Only the socket this process bound: a same-user supervisor that took over after our
      // server closed keeps its own socket.
      const now = statSync(this.paths.socket);
      if (
        this.socketIdentity &&
        now.dev === this.socketIdentity.dev &&
        now.ino === this.socketIdentity.ino
      )
        unlinkSync(this.paths.socket);
    } catch {
      // Already gone.
    }
    this.status.clear();
    this.log.write("Supervisor stopped.");
  }

  sleep(ms) {
    return new Promise((resolve) => {
      let waited = 0;
      const step = Math.min(200, Math.max(1, ms));
      const tick = () => {
        waited += step;
        if (this.stopping || waited >= ms) {
          resolve();
          return;
        }
        setTimeout(tick, step).unref?.();
      };
      setTimeout(tick, step).unref?.();
    });
  }
}

function named(reason, message) {
  return Object.assign(new Error(message), { reason });
}

function exitCodeOf(child) {
  return child.exitCode === null ? "running" : String(child.exitCode);
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function canConnect(path) {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

async function shutdownChild(child, log) {
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write("shutdown\n");
    const exited = await waitForExit(child, SHUTDOWN_WAIT_MS);
    if (!exited) {
      log.write("Daemon did not stop after shutdown; killed.");
      child.kill("SIGKILL");
      await waitForExit(child, 2000);
    }
  } catch (error) {
    log.write("Daemon shutdown failed: " + error.message);
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export { PHASE_TIMEOUT_MS };
