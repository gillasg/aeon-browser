import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  clipboardCommands,
  copyToClipboard,
  detectBrowsers,
  loadUnpackedSteps,
  matchReleaseAsset,
  resolveExtensionFolder,
  sourceBuilds,
} from "../apps/bridge/dist/setup-extension.js";
import { waitForConnection } from "../apps/bridge/dist/commands/browser.js";

const existing = (paths) => (path) => paths.includes(path);

test("the source checkout's Aeon extension is preferred over browserkit's", () => {
  const [aeon, aeonDist, browserkit] = sourceBuilds(
    pathToFileURL(resolve("/repo/browser/apps/bridge/dist/x.js")).href,
  );
  assert.equal(aeon, resolve("/repo/apps/chrome-extension/native-dist"));
  assert.equal(aeonDist, resolve("/repo/apps/chrome-extension/dist"));
  assert.equal(browserkit, resolve("/repo/browser/apps/extension/build"));
  const all = [aeon, aeonDist, browserkit];
  assert.equal(
    resolveExtensionFolder(all, existing([join(browserkit, "manifest.json")])),
    browserkit,
  );
  assert.equal(
    resolveExtensionFolder(
      all,
      existing([join(aeon, "manifest.json"), join(browserkit, "manifest.json")]),
    ),
    aeon,
  );
  assert.equal(resolveExtensionFolder(all, existing([])), undefined);
});

test("release assets match the newest naming first", () => {
  const asset = (name) => ({ name, browser_download_url: `https://x/${name}` });
  assert.equal(
    matchReleaseAsset([asset("browserkit-0.3.zip"), asset("aeon-extension-1.0.zip")]).name,
    "aeon-extension-1.0.zip",
  );
  assert.equal(
    matchReleaseAsset([asset("aeon-browser-extension-1.0.zip"), asset("notes.txt")]).name,
    "aeon-browser-extension-1.0.zip",
  );
  assert.equal(matchReleaseAsset([asset("browserkit-0.3.zip")]).name, "browserkit-0.3.zip");
  assert.equal(matchReleaseAsset([asset("aeon-cli.tar.gz")]), undefined);
  assert.equal(matchReleaseAsset(undefined), undefined);
});

test("installed browsers are found on macOS, Linux and Windows", () => {
  const mac = detectBrowsers({
    platform: "darwin",
    home: "/Users/a",
    exists: existing(["/Applications/Brave Browser.app", "/Users/a/Applications/Arc.app"]),
  });
  assert.deepEqual(
    mac.map((browser) => browser.name),
    ["Brave", "Arc"],
  );
  assert.deepEqual(mac[0].open("brave://extensions"), [
    "open",
    ["-a", "Brave Browser", "brave://extensions"],
  ]);
  assert.equal(mac[0].extensionsPage, "brave://extensions");

  const linux = detectBrowsers({
    platform: "linux",
    env: { PATH: "/usr/bin:/snap/bin" },
    exists: existing(["/snap/bin/chromium", "/usr/bin/google-chrome-stable"]),
  });
  assert.deepEqual(
    linux.map((browser) => browser.name),
    ["Google Chrome", "Chromium"],
  );
  assert.deepEqual(linux[0].open("chrome://extensions"), [
    "google-chrome-stable",
    ["chrome://extensions"],
  ]);

  const windows = detectBrowsers({
    platform: "win32",
    env: { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    exists: existing([
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Users\\a\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
    ]),
  });
  assert.deepEqual(
    windows.map((browser) => [browser.name, browser.extensionsPage]),
    [
      ["Microsoft Edge", "edge://extensions"],
      ["Chrome Canary", "chrome://extensions"],
    ],
  );
  assert.deepEqual(detectBrowsers({ platform: "linux", env: {}, exists: () => false }), []);
});

test("the clipboard falls back from wl-copy to xclip to xsel on Linux", () => {
  assert.deepEqual(
    clipboardCommands("linux").map(([command]) => command),
    ["wl-copy", "xclip", "xsel"],
  );
  assert.deepEqual(clipboardCommands("darwin"), [["pbcopy", []]]);
  assert.deepEqual(clipboardCommands("win32"), [["clip", []]]);
  const tried = [];
  const result = copyToClipboard("/x/ext", {
    platform: "linux",
    run: (command, _args, input) => {
      tried.push(command);
      assert.equal(input, "/x/ext");
      if (command !== "xsel") throw new Error("missing");
    },
  });
  assert.deepEqual(result, { copied: true, tool: "xsel" });
  assert.deepEqual(tried, ["wl-copy", "xclip", "xsel"]);
  const none = copyToClipboard("/x", {
    platform: "darwin",
    run: () => {
      throw new Error("no");
    },
  });
  assert.deepEqual(none, { copied: false });
});

test("the steps are numbered and say whether the path is on the clipboard", () => {
  const copied = loadUnpackedSteps("/x/ext", {
    copied: true,
    browser: "Brave",
    page: "brave://extensions",
    platform: "darwin",
  }).join("\n");
  assert.match(copied, /brave:\/\/extensions is open in Brave/);
  assert.match(copied, /1\. Turn on Developer mode/);
  assert.match(copied, /2\. Click Load unpacked/);
  assert.match(copied, /3\. Paste \(Cmd\+V\).*already on your clipboard/);
  assert.match(copied, /\/x\/ext/);
  const failed = loadUnpackedSteps("/x/ext", { copied: false, platform: "linux" }).join("\n");
  assert.match(failed, /no clipboard tool worked/);
  assert.doesNotMatch(failed, /Ctrl\+V/);
});

test("setup polls until the extension connects", async () => {
  let calls = 0;
  const ok = await waitForConnection(
    { timeoutMs: 10_000, everyMs: 1000 },
    async () => ++calls === 3,
    async () => {},
  );
  assert.equal(ok, true);
  assert.equal(calls, 3);
  const never = await waitForConnection(
    { timeoutMs: 3000, everyMs: 1000 },
    async () => false,
    async () => {},
  );
  assert.equal(never, false);
});
