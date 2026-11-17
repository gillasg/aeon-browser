// The bootstrap socket is per-user and owner-checked: another local user must not be able to
// pre-bind the path, answer as the supervisor, or read a bootstrap sent to it.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureSocketDirectory, runtimeDirectory, socketPath } from "../node/paths.mjs";
import { exchange } from "../node/host.mjs";
import {
  bootstrapRequest,
  createSandbox,
  hostEntry,
  nativeBootstrap,
  waitForExit,
  writeConfig,
} from "./node-helpers.mjs";

const posix = process.platform !== "win32";

test("the socket directory is 0700 and a foreign or loose one is refused", { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), "aeon-socket-dir-"));
  const uid = process.getuid();
  const directory = join(root, "aeon");
  try {
    ensureSocketDirectory(directory, { uid });
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    chmodSync(directory, 0o755);
    assert.throws(() => ensureSocketDirectory(directory, { uid }), /not 700/);
    chmodSync(directory, 0o700);
    assert.throws(() => ensureSocketDirectory(directory, { uid: uid + 1 }), /owned by uid/);
    const link = join(root, "link");
    symlinkSync(directory, link);
    assert.throws(() => ensureSocketDirectory(link, { uid }), /not a real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "the host refuses a socket owned by another uid before connecting",
  { skip: !posix },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "aeon-socket-foreign-"));
    const path = join(root, "bootstrap.sock");
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((done) => server.listen(path, done));
    let connected = false;
    server.on("connection", () => (connected = true));
    try {
      await assert.rejects(
        exchange(path, Buffer.from(JSON.stringify(bootstrapRequest())), {
          uid: process.getuid() + 1,
        }),
        /owned by uid/,
      );
      assert.equal(connected, false, "the host connected to a foreign socket");
    } finally {
      await new Promise((done) => server.close(done));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "another local user cannot pre-bind the bootstrap socket",
  { skip: skipForeignUserTest() },
  async () => {
    const sandbox = createSandbox();
    writeConfig(sandbox);
    // A world-writable runtime root: the other user creates the per-user socket directory first
    // and listens inside it. The victim must refuse the directory, not trust it. Use /tmp itself,
    // not os.tmpdir(): on macOS the latter is the runner's private T folder, which a second user
    // cannot traverse even when the leaf is chmod 0777, so the attacker could never start.
    const runtime = mkdtempSync(join("/tmp", "aeon-runtime-"));
    chmodSync(runtime, 0o777);
    const env = { ...sandbox.env, XDG_RUNTIME_DIR: runtime };
    const directory = runtimeDirectory({ env, platform: "linux", home: sandbox.home });
    const path = socketPath({
      env,
      platform: "linux",
      home: sandbox.home,
      uid: process.getuid(),
    });
    const attacker = attackSocket(directory, path);
    try {
      await attacker.ready;
      // The victim's supervisor must refuse the directory and the host must stay offline.
      const supervisor = spawn(process.execPath, [hostEntry, "--daemon-supervisor"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      supervisor.stdout.setEncoding("utf8");
      supervisor.stderr.setEncoding("utf8");
      supervisor.stdout.on("data", (chunk) => (output += chunk));
      supervisor.stderr.on("data", (chunk) => (output += chunk));
      const exit = await waitForExit(supervisor, 8_000);
      assert.equal(exit.code, 1, output + readLog(sandbox));
      assert.match(output + readLog(sandbox), /Bootstrap socket refused/);
      const { result } = await nativeBootstrap(sandbox, bootstrapRequest(), {
        env: {
          XDG_RUNTIME_DIR: runtime,
          AEON_CONNECT_ATTEMPTS: "1",
          AEON_CONNECT_WAIT_MS: "10",
        },
        timeoutMs: 10_000,
      });
      assert.equal(result?.ok, false);
      assert.equal(result?.code, "DAEMON_OFFLINE");
      assert.equal(attacker.received(), 0, "a bootstrap reached the other user's socket");
    } finally {
      attacker.stop();
      sudo(["rm", "-rf", runtime]);
      rmSync(runtime, { recursive: true, force: true });
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

function readLog(sandbox) {
  try {
    return readFileSync(join(sandbox.app, "daemon-supervisor.log"), "utf8");
  } catch {
    return "";
  }
}

function skipForeignUserTest() {
  if (!posix) return "Mac/Linux only";
  if (typeof process.getuid !== "function") return "needs uid";
  if (!sudoAvailable()) return "needs passwordless sudo for a second local user";
  if (sudo(["python3", "-c", "import socket"]) !== 0) return "needs python3 for the other user";
  return false;
}

function sudoAvailable() {
  return sudo(["true"]) === 0;
}

function sudo(args) {
  try {
    execFileSync("sudo", ["-n", "-u", "nobody", ...args], { stdio: "ignore" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

/** Runs the other user's listener; the file it writes counts the bytes it received. */
function attackSocket(directory, path) {
  // The attacker (nobody) must be able to write this file; os.tmpdir() is private on macOS.
  const countFile = join("/tmp", "aeon-attack-" + process.pid + "-" + Date.now());
  const script = [
    "import os, socket, sys, time",
    "path, count = sys.argv[1], sys.argv[2]",
    "os.makedirs(os.path.dirname(path), mode=0o700)",
    "server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
    "server.bind(path)",
    "server.listen(1)",
    "server.settimeout(12)",
    "open(count, 'w').write('0')",
    "print('READY', flush=True)",
    "try:",
    "    connection, _ = server.accept()",
    "    data = connection.recv(4096)",
    "    open(count, 'w').write(str(len(data)))",
    "    time.sleep(1)",
    "except Exception:",
    "    pass",
  ].join("\n");
  const child = spawn("sudo", ["-n", "-u", "nobody", "python3", "-c", script, path, countFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("attacker never started: " + output)), 8_000);
    const tick = () => {
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve(undefined);
      } else setTimeout(tick, 50);
    };
    tick();
  });
  return {
    ready,
    received() {
      try {
        return Number(readFileSync(countFile, "utf8"));
      } catch {
        return 0;
      }
    },
    stop() {
      child.kill("SIGKILL");
      sudo(["rm", "-f", countFile]);
      rmSync(countFile, { force: true });
    },
  };
}
