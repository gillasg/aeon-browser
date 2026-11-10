import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ENGINE_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";
import { CHROME_FLAGS, doctorChecks, formatDoctor } from "../dist/doctor-checks.js";
import { directoryWritable, modelSignedIn } from "../dist/doctor-io.js";
import { runDoctor } from "../dist/doctor.js";

const version = SUPPORTED_PROTOCOL_VERSION;
const flags = CHROME_FLAGS.join(" ");

function facts(overrides = {}) {
  return {
    daemon: {
      ok: true,
      extension: true,
      engine: true,
      protocolVersion: version,
      engineProtocol: ENGINE_PROTOCOL_VERSION,
    },
    chromeCommandLines: [`chrome.exe ${flags}`],
    modelSignedIn: true,
    loginTask: true,
    dirs: [{ name: "Aeon", path: "C:\\Aeon\\data", writable: true }],
    ...overrides,
  };
}

test("doctor is all ok when the ping, flags, model, task and folders agree", () => {
  const checks = doctorChecks(facts());
  assert.deepEqual(
    checks.map((check) => check.status),
    ["ok", "ok", "ok", "ok", "ok", "ok", "ok"],
  );
  assert.match(formatDoctor(checks, false), /daemon +ok +The daemon answered/);
  assert.equal(formatDoctor(checks, false).includes("Fix:"), false);
  const json = JSON.parse(formatDoctor(checks, true));
  assert.equal(json.ok, true);
  assert.equal(json.checks.length, 7);
  assert.ok(json.checks.every((check) => check.fix));
});

test("each failed check names the one fix", () => {
  const checks = doctorChecks(
    facts({
      daemon: undefined,
      chromeCommandLines: ["chrome.exe --silent-debugger-extension-api"],
      modelSignedIn: false,
      loginTask: false,
      dirs: [{ name: "Aeon", path: "C:\\Aeon\\data", writable: false }],
    }),
  );
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName.daemon.status, "fail");
  assert.match(byName.daemon.fix, /Open Chrome with Aeon loaded/);
  assert.equal(byName.protocol.status, "fail");
  assert.equal(byName.extension.status, "fail");
  assert.match(byName.extension.fix, /Aeon extension loaded/);
  assert.equal(byName.flags.status, "fail");
  assert.match(byName.flags.detail, /disable-background-timer-throttling/);
  assert.match(byName.flags.fix, /Restart Chrome with these flags/);
  assert.match(byName.model.fix, /Sign in to a model/);
  assert.match(byName.supervisor.fix, /Aeon-Core-Login/);
  assert.match(byName.data.fix, /C:\\Aeon\\data/);
  assert.match(formatDoctor(checks, false), /Fix: Open Chrome with Aeon loaded/);
});

test("a daemon that answers still fails protocol and engine when those disagree", () => {
  const mismatched = doctorChecks(
    facts({
      daemon: {
        ok: false,
        extension: true,
        engine: false,
        protocolVersion: { major: version.major, minor: version.minor + 1 },
      },
    }),
  );
  const protocol = mismatched.find((check) => check.name === "protocol");
  const extension = mismatched.find((check) => check.name === "extension");
  const daemon = mismatched.find((check) => check.name === "daemon");
  assert.equal(daemon.status, "ok");
  assert.match(protocol.detail, /does not match/);
  assert.match(protocol.fix, /same build/);
  assert.equal(extension.status, "fail");
  assert.match(extension.fix, /Reload the Aeon extension/);
});

test("an engine protocol other than this build fails the protocol check", () => {
  const checks = doctorChecks(
    facts({
      daemon: {
        ok: true,
        extension: true,
        engine: true,
        protocolVersion: version,
        engineProtocol: { major: version.major, minor: version.minor + 3 },
      },
    }),
  );
  const protocol = checks.find((check) => check.name === "protocol");
  assert.equal(protocol.status, "fail");
  assert.match(protocol.detail, /Engine protocol/);
});

test("a model credential is signed in, and a writable folder is", async () => {
  const root = await mkdtemp(join(tmpdir(), "aeon-doctor-"));
  const auth = join(root, "auth.json");
  await writeFile(auth, JSON.stringify({ anthropic: { type: "api_key", key: "secret" } }));
  assert.equal(await modelSignedIn(auth), true);
  assert.equal(await modelSignedIn(join(root, "missing.json")), false);
  await writeFile(join(root, "empty.json"), "{}");
  assert.equal(await modelSignedIn(join(root, "empty.json")), false);
  assert.equal(await directoryWritable(join(root, "data")), true);
  await mkdir(join(root, "file-as-dir"));
  await writeFile(join(root, "blocked"), "x");
  assert.equal(await directoryWritable(join(root, "blocked")), false);
});

test("runDoctor exits 1 and prints json when the daemon is down", async () => {
  let written = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    written += String(chunk);
    return true;
  };
  try {
    const code = await runDoctor(true, {
      daemon: async () => undefined,
      chromeCommandLines: async () => [],
      modelSignedIn: async () => false,
      loginTask: async () => false,
      dataDirs: async () => [{ name: "Aeon", path: "x", writable: false }],
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(written);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.checks.length, 7);
  } finally {
    process.stdout.write = write;
  }
});
