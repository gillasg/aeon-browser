// A stand-in for `apps/daemon/dist/main.js --managed-daemon`. Modes are selected with
// FAKE_DAEMON_MODE so the contract tests can drive the same scenarios as the C# suite.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const mode = process.env.FAKE_DAEMON_MODE ?? "normal";
const data = process.env.AEON_NATIVE_DATA_DIR;
const origin = process.env.AEON_NATIVE_EXTENSION_ORIGIN;
const countPath = join(data ?? ".", "fake-daemon-starts");
const shutdownPath = join(data ?? ".", "fake-daemon-shutdown");

appendFileSync(countPath, "1\n");
writeFileSync(join(data ?? ".", "fake-daemon-pid"), String(process.pid));
writeFileSync(join(data ?? ".", "fake-daemon-origin"), String(origin));

const write = (line) => process.stdout.write(line + "\n");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// A supervisor that is killed must not leave its fixture daemon behind.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
const supervisorPid = process.ppid;
const watchParent = () => {
  if (process.ppid !== supervisorPid) process.exit(0);
  setTimeout(watchParent, 1000);
};
watchParent();

write("AEON_DAEMON_PHASE lock");
write("AEON_DAEMON_PHASE runtime");

if (mode === "exit-immediately") {
  write("AEON_DAEMON_PHASE initialize");
  process.exit(2);
}
if (mode === "stall") {
  write("AEON_DAEMON_PHASE initialize");
  await new Promise(() => {
    const tick = () => setTimeout(tick, 1000);
    tick();
  });
}

write("AEON_DAEMON_PHASE ready");
write("AEON_DAEMON_READY");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line === "shutdown") {
    writeFileSync(shutdownPath, new Date().toISOString());
    process.exit(0);
  }
  if (!line) continue;
  const message = parse(line);
  if (message?.kind === "supervisor.health") {
    if (mode !== "silent") write(base64({ kind: "supervisor.health.result", ok: true }));
    continue;
  }
  if (mode === "silent" || mode === "health-only") continue;
  write(base64(reply(message)));
  if (mode === "crash-after-reply") {
    await delay(50);
    process.exit(3);
  }
}

function parse(line) {
  try {
    return JSON.parse(Buffer.from(line, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function base64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function reply(envelope) {
  return {
    kind: "native.bootstrap.result",
    protocolVersion: { major: 1, minor: 1 },
    ok: true,
    endpoint: "ws://127.0.0.1:1/aeon/v1",
    connectionGrant: "a".repeat(43),
    expiresAt: 4102444800000,
    daemonProtocolVersion: { major: 1, minor: 1 },
    echo: envelope?.origin,
  };
}
