import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ENGINE_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";
import {
  CHROME_FLAGS,
  chromeFlagsCommand,
  doctorChecks,
  formatDoctor,
} from "../dist/doctor-checks.js";
import { directoryWritable, modelSignedIn, supervisorServiceActive } from "../dist/doctor-io.js";
import { runDoctor } from "../dist/doctor.js";

const version = SUPPORTED_PROTOCOL_VERSION;
const flags = CHROME_FLAGS.join(" ");

test("the flags fix prints the exact relaunch command for each OS", () => {
  assert.match(chromeFlagsCommand("darwin"), /^\/Applications\/Google\\ Chrome\.app/);
  assert.match(chromeFlagsCommand("win32"), /^chrome\.exe /);
  assert.match(chromeFlagsCommand("linux"), /^google-chrome /);
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.ok(chromeFlagsCommand(platform).includes(flags));
  }
});

test("a normal Chrome launch passes the flags check; the flags are optional", () => {
  const check = doctorChecks(facts({ chromeCommandLines: [] })).find(
    (item) => item.name === "flags",
  );
  assert.equal(check?.status, "ok");
  assert.match(check?.detail ?? "", /normal Chrome launch/);
});

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
  assert.match(checks.find((check) => check.name === "supervisor").detail, /is running\./);
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
  assert.equal(byName.flags.status, "ok");
  assert.match(byName.flags.detail, /normal Chrome launch/);
  assert.match(byName.flags.fix, /Optional: relaunch Chrome/);
  assert.match(byName.model.fix, /Sign in to a model/);
  assert.match(byName.supervisor.detail, /is not running\./);
  assert.match(byName.supervisor.fix, /Aeon/);
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

test("the supervisor check follows the service manager, not the unit file", async () => {
  const root = await mkdtemp(join(tmpdir(), "aeon-doctor-service-"));
  const home = join(root, "home");
  const env = { XDG_CONFIG_HOME: join(home, ".config") };
  const unit = join(env.XDG_CONFIG_HOME, "systemd", "user", "aeon-daemon.service");
  try {
    assert.equal(
      await supervisorServiceActive({
        platform: "linux",
        home,
        env,
        exec: async () => {
          throw new Error("must not run without a unit file");
        },
      }),
      false,
    );
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, "unit");
    const calls = [];
    assert.equal(
      await supervisorServiceActive({
        platform: "linux",
        home,
        env,
        exec: async (file, args) => {
          calls.push([file, ...args]);
          return true;
        },
      }),
      true,
    );
    assert.deepEqual(calls, [
      ["systemctl", "--user", "is-active", "--quiet", "aeon-daemon.service"],
    ]);
    assert.equal(
      await supervisorServiceActive({ platform: "linux", home, env, exec: async () => false }),
      false,
    );

    const plist = join(home, "Library", "LaunchAgents", "com.aeon.daemon.plist");
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, "plist");
    const macCalls = [];
    assert.equal(
      await supervisorServiceActive({
        platform: "darwin",
        home,
        env,
        uid: 42,
        exec: async (file, args) => {
          macCalls.push([file, ...args]);
          return true;
        },
      }),
      true,
    );
    assert.deepEqual(macCalls, [["launchctl", "print", "gui/42/com.aeon.daemon"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
