// `aeon record shoot` plans and `aeon record ui` routing: parsing, validation, the run order, and
// that capture always stops when a step fails.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { parsePlan, sceneFolder, shoot, shootTarget } from "../dist/record-shoot.js";
import {
  chordCommand,
  pageCode,
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
  assert.equal(pageUrl(id, "home"), `chrome-extension://${id}/home.html?host=panel`);
  assert.equal(pageUrl(id, "chat"), `chrome-extension://${id}/home.html?host=panel`);
  assert.equal(pageUrl(id, "manage"), `chrome-extension://${id}/home.html`);
  for (const view of ["chats", "automations", "sites", "settings", "models", "learn"])
    assert.deepEqual(resolveUiAction(view, id), {
      kind: "page",
      url: `chrome-extension://${id}/home.html?view=${view}`,
    });
  assert.deepEqual(resolveUiAction("cursor", id), { kind: "keys", chords: ["cursor"] });
  assert.deepEqual(resolveUiAction("sidepanel", id), { kind: "keys", chords: ["cursor", "panel"] });
  assert.deepEqual(resolveUiAction("reload", id), { kind: "reload" });
  assert.throws(() => resolveUiAction("bogus", id), /Usage: aeon record ui/);
  assert.equal(UI_ACTIONS.length, 12);
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
  assert.match(ran[0], /const url = "chrome-extension:\/\/id\/home\.html\?view=settings"/);
  assert.match(ran[0], /\.cdp\("Page\.navigate", \{ url \}\)/);
  // No new tab (it would join the session's tab group) and no kept page.
  assert.doesNotMatch(ran[0], /openTab|keepPage/);
  await performUi("reload", deps);
  assert.match(ran[1], /\.reload\(\)/);
  await performUi("sidepanel", deps);
  assert.deepEqual(pressed, ["alt+shift+space", "ctrl+Return"]);
});

test("pageCode reuses one Aeon or blank tab in place and closes the duplicates", async () => {
  const url = "chrome-extension://id/home.html?view=sites";
  const play = async (tabs) => {
    const log = [];
    const browser = {
      tabs: async () => tabs,
      closeTab: async (id) => log.push(["close", id]),
      page: (id) => ({
        navigate: async (to) => log.push(["navigate", id, to]),
        cdp: async (method, params) => log.push([method, id, params.url]),
      }),
    };
    const fn = new Function("browser", `return (async () => { ${pageCode(url)} })();`);
    return { id: await fn(browser), log };
  };
  const web = { id: 1, url: "https://example.com/", active: false };
  const blank = { id: 2, url: "about:blank", active: false };
  const aeon = { id: 3, url: "chrome-extension://id/chat.html", active: true };
  assert.deepEqual(await play([web, blank, aeon]), {
    id: 3,
    log: [
      ["close", 2],
      ["Page.navigate", 3, url],
    ],
  });
  // Only a web page: it is navigated in place rather than a new tab opened.
  assert.deepEqual(await play([{ ...web, active: true }]), {
    id: 1,
    log: [["Page.navigate", 1, url]],
  });
  // A tab behind others is presented by page.navigate.
  assert.deepEqual(await play([{ ...blank }, { ...web, active: false }]), {
    id: 2,
    log: [["navigate", 2, url]],
  });
  // Already there and in front: nothing moves.
  assert.deepEqual(await play([{ id: 4, url, active: true }]), { id: 4, log: [] });
});

test("prepare steps run before the camera rolls and never take marks", async () => {
  const parsed = parsePlan({
    scenes: [{ name: "a", prepare: [{ ui: "sites" }, { wait: "idle" }], steps: [{ hold: 5 }] }],
  });
  assert.deepEqual(parsed.scenes[0].prepare, [{ ui: "sites" }, { wait: "idle" }]);
  const bad = (prepare) => () => parsePlan({ scenes: [{ name: "a", prepare, steps: [] }] });
  assert.throws(bad([{ mark: "x" }]), /prepare\[0\].*before recording starts/);
  assert.throws(bad([{ ui: "cursor", mark: "x" }]), /no marks/);
  assert.throws(bad([{ run: "go" }]), /prepare/);
  assert.throws(bad([{ terminal: "ls" }]), /prepare/);
  assert.throws(bad("nope"), /prepare is a list/);
  const calls = [];
  const deps = new Proxy(
    { join: (a, b) => `${a}/${b}`, log: () => undefined },
    {
      get: (target, key) =>
        target[key] ??
        (async (...args) => void calls.push([key, ...args.filter((a) => typeof a !== "object")])),
    },
  );
  await shoot(parsed, "out", deps);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["ui", "wait", "start", "hold", "stop"],
  );
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
