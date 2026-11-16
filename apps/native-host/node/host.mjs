import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostPaths } from "./paths.mjs";
import { loadConfig } from "./config.mjs";
import { SupervisorLog } from "./supervisor-files.mjs";
import { readFrame, writeFrame } from "./frames.mjs";
import { bootstrapEnvelope, failure, matchesOrigin } from "./protocol.mjs";
import { serviceState, startService } from "./service-state.mjs";
import { runSupervisor } from "./supervisor.mjs";

const ENTRY = fileURLToPath(new URL("./native-host.mjs", import.meta.url));
const CONNECT_ATTEMPTS = 80;
const CONNECT_WAIT_MS = 200;
const REPLY_TIMEOUT_MS = 10_000;

/** Chrome's native messaging entrypoint: one framed request in, one framed response out. */
export async function runHost(args = process.argv.slice(2)) {
  const paths = hostPaths();
  const log = new SupervisorLog(paths.log);
  let config;
  try {
    config = await loadConfig(paths.config);
  } catch (error) {
    log.write("Native configuration rejected: " + error.message);
    await writeFailure("HOST_CONFIG_INVALID", false);
    return 0;
  }
  if (args.length === 0 || !matchesOrigin(args[0], "chrome-extension://" + config.extensionId)) {
    await writeFailure("ORIGIN_NOT_ALLOWED", false);
    return 0;
  }
  try {
    const request = await readFrame(process.stdin);
    if (request === null) return 0;
    const response = await sendToSupervisor(config, args[0], request, paths.socket, log);
    await writeFrame(process.stdout, response);
    return 0;
  } catch (error) {
    if (error.name === "InvalidFrameError") await writeFailure("INVALID_REQUEST", false);
    else await writeFailure("DAEMON_OFFLINE", true);
    return 0;
  }
}

async function sendToSupervisor(config, origin, request, socketPath, log) {
  const envelope = Buffer.from(JSON.stringify(bootstrapEnvelope(origin, request)), "utf8");
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    try {
      return await exchange(socketPath, envelope);
    } catch {
      // The supervisor is not up yet, or it dropped between connects.
    }
    if (attempt % 5 === 0) ensureSupervisor(config, log);
    await new Promise((done) => setTimeout(done, CONNECT_WAIT_MS));
  }
  throw new Error("Daemon bootstrap did not become available.");
}

async function exchange(socketPath, envelope) {
  const { connect } = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Bootstrap exchange timed out."));
    }, REPLY_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("error", (error) => finish(error));
    socket.once("connect", async () => {
      try {
        await writeFrame(socket, envelope);
        const response = await readFrame(socket, { timeoutMs: REPLY_TIMEOUT_MS });
        if (!response) throw new Error("Bootstrap socket closed without a response.");
        finish(undefined, response);
      } catch (error) {
        finish(error);
      }
    });
  });
}

/**
 * Makes one supervisor available. The login service owns it while the service manager runs it; an
 * installed-but-stopped service is asked to start before the host falls back to a direct
 * supervisor, because a stopped unit must recover without a reinstall.
 */
export function ensureSupervisor(config, log, options = {}) {
  const state = (options.serviceState ?? serviceState)();
  if (state === "active") return "service";
  if (state === "inactive") {
    log.write("The Aeon service is installed but not running; asking it to start.");
    if ((options.startService ?? startService)({ log })) return "service";
    log.write("The Aeon service did not start; running a supervisor directly.");
  }
  spawnSupervisor(config, log, options.spawn);
  return "manual";
}

function spawnSupervisor(config, log, spawnChild = spawn) {
  try {
    const child = spawnChild(config.nodeExecutable, [ENTRY, "--daemon-supervisor"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (error) => log.write("Supervisor start failed: " + error.message));
    child.unref();
  } catch (error) {
    log.write("Supervisor start failed: " + error.message);
  }
}

async function writeFailure(code, retryable) {
  try {
    await writeFrame(process.stdout, failure(code, retryable));
  } catch {
    // Chrome closed the pipe first; nothing else to do.
  }
}

/** `--stop-supervisor`: asks the owner to stop and gives up after 3 s, like the C# host. */
export async function stopSupervisor() {
  const { connect } = await import("node:net");
  const { socket } = hostPaths();
  return new Promise((resolve) => {
    const client = connect(socket);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(1);
    }, 3000);
    timer.unref?.();
    const finish = (code) => {
      clearTimeout(timer);
      client.destroy();
      resolve(code);
    };
    client.once("error", () => finish(1));
    client.once("connect", async () => {
      try {
        await writeFrame(client, Buffer.from('{"kind":"supervisor.stop"}', "utf8"));
        const reply = await readFrame(client, { timeoutMs: 3000 });
        finish(reply ? 0 : 1);
      } catch {
        finish(1);
      }
    });
  });
}

export function printStatus() {
  const { status } = hostPaths();
  const text = existsSync(status) ? readFileSync(status, "utf8") : '{"state":"missing"}';
  process.stdout.write(text.trim() + "\n");
  return 0;
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--daemon-supervisor") return runSupervisor();
  if (args[0] === "--stop-supervisor") return stopSupervisor();
  if (args[0] === "--status") return printStatus();
  try {
    return await runHost(args);
  } catch {
    await writeFailure("BOOTSTRAP_UNAVAILABLE", true);
    return 1;
  }
}
