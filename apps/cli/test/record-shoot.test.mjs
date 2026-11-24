// `aeon record shoot` plans and `aeon record ui` routing: parsing, validation, the run order, and
// that capture always stops when a step fails.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { parsePlan, sceneFolder, shoot, shootTarget } from "../dist/record-shoot.js";
import {
  chordCommand,
  pageUrl,
  performUi,
  resolveUiAction,
  UI_ACTIONS,
} from "../dist/record-ui.js";
import { extensionUrl } from "../dist/extension-url.js";

const plan = {
  out: "takes",
  scenes: [
    {
      name: "Open the site",
      steps: [
        { open: "https://example.com" },
        { ui: "cursor", mark: "summon" },
        { ui: { action: "sidepanel" } },
        { run: { prompt: "find the price", tail: 1 } },
        { mark: "arrive", selector: "#price", cue: "arrive" },
        { wait: "selector", selector: "#price" },
        { wait: { for: "idle" } },
        { hold: 1500 },
        { reload: true },
        { terminal: "echo hi" },
        { code: "return 1", timeout: 5000 },
      ],
    },
    { name: "Manage", steps: [{ ui: "models" }, { hold: { ms: 10 } }] },
  ],
};

test("a plan parses short and long step forms", () => {
  const parsed = parsePlan(plan);
  assert.equal(parsed.out, "takes");
  assert.deepEqual(parsed.scenes[0].steps, [
    { open: "https://example.com" },
    { ui: "cursor", mark: "summon" },
    { ui: "sidepanel" },
    { run: "find the price", tail: 1 },
    { mark: "arrive", selector: "#price", cue: "arrive" },
    { wait: "selector", selector: "#price" },
    { wait: "idle" },
    { hold: 1500 },
    { reload: true },
    { terminal: "echo hi" },
    { code: "return 1", timeout: 5000 },
  ]);
  assert.deepEqual(parsed.scenes[1].steps[1], { hold: 10 });
});

test("a bad plan fails before anything is filmed", () => {
  const bad = (steps) => () => parsePlan({ scenes: [{ name: "a", steps }] });
  assert.throws(() => parsePlan({}), /at least one scene/);
  assert.throws(() => parsePlan({ scenes: [] }), /at least one scene/);
  assert.throws(
    () =>
      parsePlan({
        scenes: [
          { name: "a", steps: [] },
          { name: "a", steps: [] },
        ],
      }),
    /named twice/,
  );
  assert.throws(bad([{ ui: "bogus" }]), /steps\[0\]: ui is one of/);
  assert.throws(bad([{ open: "x", hold: 1 }]), /exactly one/);
  assert.throws(bad([{ wait: "selector" }]), /needs "selector"/);
  assert.throws(bad([{ wait: "soon" }]), /wait is for/);
  assert.throws(bad([{ mark: "m", cue: "boom" }]), /cue is one of/);
  assert.throws(bad([{ hold: -1 }]), /hold needs ms/);
  assert.throws(bad([{ run: { prompt: "x", tail: "2" } }]), /numbers/);
  assert.throws(bad(["open"]), /a step is an object/);
});

test("scene folders sort in story order", () => {
  assert.equal(sceneFolder(0, "Open the Site!"), "01-open-the-site");
  assert.equal(sceneFolder(11, "***"), "12-scene");
});

function fakeDeps(failOn) {
  const calls = [];
  const deps = { join, log: () => undefined };
  for (const name of [
    "start",
    "stop",
    "open",
    "ui",
    "mark",
    "wait",
    "hold",
    "reload",
    "terminal",
    "code",
  ])
    deps[name] = async (...args) => {
      calls.push([name, ...args.map((a) => (typeof a === "string" ? a.replace(/\\/g, "/") : a))]);
      if (name === failOn) throw new Error(`${name} failed`);
    };
  deps.run = async (...args) => {
    calls.push(["run", args[1].run]);
    return "chat-1";
  };
  return { deps, calls };
}

test("shoot runs every step in order, one take per scene", async () => {
  const { deps, calls } = fakeDeps();
  const folders = await shoot(parsePlan(plan), "out", deps);
  assert.deepEqual(
    folders.map((f) => f.replace(/\\/g, "/")),
    ["out/01-open-the-site", "out/02-manage"],
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    [
      "start",
      "open",
      "ui",
      "ui",
      "run",
      "mark",
      "wait",
      "wait",
      "hold",
      "reload",
      "terminal",
      "code",
      "stop",
      "start",
      "ui",
      "hold",
      "stop",
    ],
  );
  assert.deepEqual(calls[2], ["ui", "cursor", "out/01-open-the-site", "summon"]);
  assert.deepEqual(calls[12], ["stop", "out/01-open-the-site", "chat-1"]);
  assert.deepEqual(calls[16], ["stop", "out/02-manage", undefined]);
});

test("a failing step still stops its take and ends the shoot", async () => {
  const { deps, calls } = fakeDeps("wait");
  await assert.rejects(shoot(parsePlan(plan), "out", deps), /wait failed/);
  assert.equal(calls.at(-1)[0], "stop");
  assert.equal(calls.filter((c) => c[0] === "start").length, 1);
  assert.equal(calls.filter((c) => c[0] === "stop").length, 1);
});

test("ui actions resolve to real extension pages and shortcuts", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  assert.equal(extensionUrl(id, "/home.html"), `chrome-extension://${id}/home.html`);
  assert.equal(pageUrl(id, "home"), `chrome-extension://${id}/home.html`);
  for (const view of ["chats", "automations", "sites", "settings", "models", "learn"])
    assert.deepEqual(resolveUiAction(view, id), {
      kind: "page",
      url: `chrome-extension://${id}/home.html?view=${view}`,
    });
  assert.deepEqual(resolveUiAction("cursor", id), { kind: "keys", chords: ["cursor"] });
  assert.deepEqual(resolveUiAction("sidepanel", id), { kind: "keys", chords: ["cursor", "panel"] });
  assert.deepEqual(resolveUiAction("reload", id), { kind: "reload" });
  assert.throws(() => resolveUiAction("bogus", id), /Usage: aeon record ui/);
  assert.equal(UI_ACTIONS.length, 10);
});

test("the cursor shortcut is Alt+Shift+Space on every OS", () => {
  assert.deepEqual(chordCommand("cursor", "linux", "42"), {
    cmd: "xdotool",
    args: ["windowfocus", "--sync", "42", "key", "--clearmodifiers", "alt+shift+space"],
  });
  assert.deepEqual(chordCommand("cursor", "linux").args, [
    "key",
    "--clearmodifiers",
    "alt+shift+space",
  ]);
  assert.match(
    chordCommand("cursor", "darwin").args[1],
    /key code 49 using \{option down, shift down\}/,
  );
  assert.match(chordCommand("cursor", "win32").args[2], /SendKeys\('%\+ '\)/);
  assert.deepEqual(chordCommand("panel", "linux").args.slice(-1), ["ctrl+Return"]);
  assert.match(chordCommand("panel", "darwin").args[1], /command down/);
  for (const os of ["linux", "darwin", "win32"])
    assert.doesNotMatch(
      JSON.stringify(chordCommand("cursor", os)),
      /ctrl\+shift|\^\+ |control down, shift/i,
    );
});

test("performUi opens pages through browser code and presses chords in order", async () => {
  const ran = [];
  const pressed = [];
  const deps = {
    extensionId: async () => "id",
    run: async (code) => ran.push(code),
    exec: (command) => pressed.push(command.args.at(-1)),
    chromeWindow: () => "7",
    sleep: async () => undefined,
    platform: "linux",
  };
  await performUi("settings", deps);
  assert.match(
    ran[0],
    /keepPage\("chrome-extension:\/\/id\/home\.html\?view=settings", \{ foreground: true \}\)/,
  );
  await performUi("reload", deps);
  assert.match(ran[1], /\.reload\(\)/);
  await performUi("sidepanel", deps);
  assert.deepEqual(pressed, ["alt+shift+space", "ctrl+Return"]);
});

test("an --out ending in .mp4 is the cut; a folder holds the takes", () => {
  const id = (p) => p.replace(/\\/g, "/");
  assert.deepEqual(shootTarget("demo/tour.MP4", false, id), {
    dir: "demo/tour",
    mp4: "demo/tour.MP4",
  });
  assert.deepEqual(shootTarget("demo", false, id), { dir: "demo" });
  assert.deepEqual(shootTarget("demo", true, id), { dir: "demo", mp4: "demo/walkthrough.mp4" });
  assert.deepEqual(shootTarget(undefined, false, id, 5), { dir: "shoot-5" });
});
