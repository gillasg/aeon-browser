// browser.openTab with several Chrome profiles connected and no tab named: it opens in the profile
// whose window the user last focused, and throws only when no connected profile has that window.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const PROFILE_A = {
  clientInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  browserRunId: "11111111-1111-4111-8111-111111111111",
  tabIncarnation: "12121212-1212-4121-8121-121212121212",
};
const PROFILE_B = {
  clientInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  browserRunId: "22222222-2222-4222-8222-222222222222",
  tabIncarnation: "23232323-2323-4232-8232-232323232323",
};
const tabIn = (profile, tabId, windowId, active) => ({
  target: { ...profile, tabId },
  windowId,
  index: 0,
  url: "https://example.test/",
  title: "Example",
  status: "complete",
  active,
  pinned: false,
  groupId: -1,
  documentEpoch: 1,
  mine: false,
});

const sandbox = readFileSync(new URL("../src/code-realm-source.ts", import.meta.url), "utf8");

async function sandboxSource() {
  const from = new Map();
  for (const match of sandbox.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+)\.js";/g))
    for (const name of match[1].split(",").map((part) => part.trim()))
      if (name) from.set(name, match[2]);
  const list = /evaluate\(\s*\[([\s\S]*?)\]\.join/.exec(sandbox);
  assert.ok(list, "code-realm-source.ts evaluates a joined list of runtime parts");
  const parts = [];
  for (const name of list[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const module = await import(new URL(`../dist/${from.get(name)}.js`, import.meta.url));
    parts.push(module[name]);
  }
  return parts.join("\n");
}

// A realm with two profiles connected; `focusedWindowId` says which window the user last focused.
async function realm(focusedWindowId, opened) {
  const tabs = [tabIn(PROFILE_A, 101, 1, true), tabIn(PROFILE_B, 201, 2, true)];
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    performance,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  };
  vm.createContext(context);
  context.globalThis = context;
  context.window = context;
  context.__call = async (request) => {
    if (request.browserInfo)
      return { clientInstanceIds: [PROFILE_A.clientInstanceId, PROFILE_B.clientInstanceId] };
    if (request.op === "listTabs") return { kind: "tabs", focusedWindowId, tabs };
    if (request.op === "openTab") {
      opened.push(request.clientInstanceId);
      const tab = tabIn(
        request.clientInstanceId === PROFILE_B.clientInstanceId ? PROFILE_B : PROFILE_A,
        999,
        1,
        false,
      );
      return { kind: "tab", tab, navigation: "ok" };
    }
    return {};
  };
  vm.runInContext(await sandboxSource(), context, { filename: "sandbox.js" });
  return async (code) => {
    vm.runInContext("__beginCell()", context);
    const value = await vm.runInContext(`(async () => {\n${code}\n})()`, context);
    await vm.runInContext("__finishCell()", context).catch(() => undefined);
    return value;
  };
}

test("openTab with two profiles and no tab named opens in the focused profile", async () => {
  const opened = [];
  const cell = await realm(2, opened);
  await cell("await browser.openTab('https://example.test/');");
  assert.deepEqual(opened, [PROFILE_B.clientInstanceId]);
});

test("openTab with two profiles throws only when no connected profile has the focused window", async () => {
  const opened = [];
  const cell = await realm(9, opened);
  await assert.rejects(
    cell("await browser.openTab('https://example.test/');"),
    /Multiple browser profiles are connected/,
  );
  assert.deepEqual(opened, []);
});
