import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MANAGED_MARK,
  applyChromeFlags,
  macApp,
  patchDesktop,
  planShortcuts,
  undoChromeFlags,
  withFlags,
} from "../dist/chrome-flags.js";
import { CHROME_FLAGS } from "../dist/doctor-checks.js";
import { setupPrompts, yes } from "../dist/setup-prompts.js";

const temp = () => mkdtempSync(join(tmpdir(), "graft-flags-"));
const count = (text, flag) => text.split(flag).length - 1;

const DESKTOP = `[Desktop Entry]
Name=Google Chrome
Exec=/usr/bin/google-chrome-stable --user-flag %U
[Desktop Action new-window]
Exec=/usr/bin/google-chrome-stable
`;

test("Linux: copies the system .desktop, adds flags once, keeps user args, undo removes it", () => {
  const home = temp();
  const source = join(home, "system.desktop");
  writeFileSync(source, DESKTOP);
  const env = { platform: "linux", home, data: join(home, "data"), linuxSources: [source] };
  assert.equal(applyChromeFlags(env).done, true);
  assert.equal(applyChromeFlags(env).done, true);
  const target = join(home, ".local", "share", "applications", "google-chrome.desktop");
  const text = readFileSync(target, "utf8");
  assert.equal(count(text, MANAGED_MARK), 1);
  for (const flag of CHROME_FLAGS) assert.equal(count(text, flag), 2);
  assert.match(text, /Exec=\/usr\/bin\/google-chrome-stable --user-flag --\S.* %U/);
  assert.match(text, /--silent-debugger-extension-api/);
  assert.equal(readFileSync(source, "utf8"), DESKTOP);
  undoChromeFlags(env);
  assert.equal(existsSync(target), false);
});

test("Linux: no Chrome entry is a skip, and undo leaves an unmanaged file alone", () => {
  const home = temp();
  const env = { platform: "linux", home, data: home, linuxSources: [join(home, "none")] };
  assert.equal(applyChromeFlags(env).done, false);
  const dir = join(home, ".local", "share", "applications");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "google-chrome.desktop"), DESKTOP);
  undoChromeFlags(env);
  assert.equal(readFileSync(join(dir, "google-chrome.desktop"), "utf8"), DESKTOP);
});

test("patchDesktop is idempotent", () => {
  const once = patchDesktop(DESKTOP);
  assert.equal(patchDesktop(once), once);
});

test("macOS: creates Graft Chrome.app with the flags and undo removes it", () => {
  const home = temp();
  const env = { platform: "darwin", home, data: home };
  applyChromeFlags(env);
  const app = macApp(env);
  const exe = join(app, "Contents", "MacOS", "graft-chrome");
  assert.match(readFileSync(join(app, "Contents", "Info.plist"), "utf8"), /graft-chrome/);
  const script = readFileSync(exe, "utf8");
  for (const flag of CHROME_FLAGS) assert.equal(count(script, flag), 1);
  if (process.platform !== "win32") assert.ok(statSync(exe).mode & 0o100);
  undoChromeFlags(env);
  assert.equal(existsSync(app), false);
});

test("Windows: args builder never duplicates; undo restores the first-seen args", () => {
  assert.equal(withFlags(withFlags("--profile-directory=A")), withFlags("--profile-directory=A"));
  const plan = planShortcuts(
    [{ path: "C:/d/Google Chrome.lnk", args: withFlags("") }],
    [{ path: "C:/d/Google Chrome.lnk", args: "" }],
  );
  assert.deepEqual(plan.record, [{ path: "C:/d/Google Chrome.lnk", args: "" }]);
  const home = temp();
  const calls = [];
  let shortcut = { path: "C:/d/Google Chrome.lnk", args: "--profile-directory=A" };
  const powershell = (_script, args) => {
    calls.push(args);
    if (!args.length) return JSON.stringify([shortcut]);
    shortcut = JSON.parse(args[1])[0];
    return "";
  };
  const env = { platform: "win32", home, data: join(home, "data"), powershell };
  applyChromeFlags(env);
  applyChromeFlags(env);
  for (const flag of CHROME_FLAGS) assert.equal(count(shortcut.args, flag), 1);
  undoChromeFlags(env);
  assert.equal(shortcut.args, "--profile-directory=A");
  assert.equal(existsSync(join(home, "data", "chrome-shortcuts.json")), false);
});

const deps = (answers, over = {}) => {
  const done = [];
  return {
    done,
    deps: {
      interactive: true,
      ask: async () => answers.shift() ?? "",
      say: () => {},
      applyFlags: () => (done.push("flags"), { done: true, detail: "ok" }),
      detectAgents: async () => ["codex"],
      connectAgents: async () => void done.push("agents"),
      connectedModels: async () => 0,
      login: async () => (done.push("login"), 0),
      ...over,
    },
  };
};

test("non-interactive (--yes / no TTY) asks nothing and does nothing", async () => {
  const { done, deps: d } = deps([], {
    interactive: false,
    ask: () => assert.fail("must not ask"),
  });
  assert.deepEqual(await setupPrompts(d), []);
  assert.deepEqual(done, []);
});

test("defaults: flags off, agents and login on", async () => {
  const { done, deps: d } = deps(["", "", ""]);
  assert.equal((await setupPrompts(d)).length, 3);
  assert.deepEqual(done, ["agents", "login"]);
});

test("no agents and a connected model skip those questions", async () => {
  const { done, deps: d } = deps(["y"], {
    detectAgents: async () => [],
    connectedModels: async () => 1,
  });
  assert.equal((await setupPrompts(d)).length, 1);
  assert.deepEqual(done, ["flags"]);
  assert.equal(yes("No", true), false);
});
