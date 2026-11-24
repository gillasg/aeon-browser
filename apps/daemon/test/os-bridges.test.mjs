// OS bridges: deep-link validation and opening, the keychain probe, and the peer-extension allowlist,
// all against a fake runner: nothing is opened and no secret store is touched.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtensionCoopRegistry,
  openDeepLink,
  openerFor,
  probeKeychain,
  validateDeepLink,
} from "../dist/os-bridges.js";

test("safe app schemes pass", () => {
  for (const uri of [
    "mailto:a@b.test",
    "slack://channel?team=T1",
    "notion://www.notion.so/page",
    "vscode://file/home/x/a.ts",
    "cursor://anysphere.cursor-retrieval",
    "obsidian://open?vault=v",
    "linear://team/issue/ABC-1",
    "figma://file/xyz",
    "zoommtg://zoom.us/join?confno=123",
    "https://example.test/path",
  ])
    assert.equal(validateDeepLink(uri).ok, true, uri);
});

test("dangerous schemes, control characters and shell metacharacters are rejected", () => {
  for (const uri of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<b>x</b>",
    "vbscript:msgbox",
    "ms-msdt:/id",
    "slack://x\u0000y",
    "slack://x\ny",
    "https://a.test/‮",
    "slack://x;rm -rf ~",
    "slack://x$(id)",
    "slack://x`id`",
    "slack://x|cat",
    "https://",
    "noscheme",
    "",
    42,
    "https://a.test/" + "x".repeat(2100),
  ])
    assert.equal(validateDeepLink(uri).ok, false, String(uri));
});

test("query strings with & are allowed, and shell metacharacters still are not", () => {
  for (const uri of [
    "mailto:?subject=a&body=b",
    "mailto:a@b.test?cc=c@d.test&subject=Hi%20there",
    "slack://channel?team=T1&id=C2",
    "https://example.test/search?q=a&page=2",
  ])
    assert.equal(validateDeepLink(uri).ok, true, uri);
  for (const uri of [
    "mailto:?subject=a;rm -rf ~",
    "mailto:?subject=a|cat",
    "mailto:?subject=a`id`",
    "mailto:?subject=$(id)",
    "mailto:?subject=a\nBcc: x@y.test",
    "mailto:?subject=a\rb",
    "mailto:?subject=a'b",
    'mailto:?subject="a"',
    "mailto:?subject=<a>",
    "mailto:?subject={a}",
    "mailto:?subject=a\\b",
  ])
    assert.equal(validateDeepLink(uri).ok, false, JSON.stringify(uri));
});

test("openDeepLink passes the URI as one argument with no shell, and never runs a rejected one", async () => {
  const calls = [];
  const run = async (file, args) => (calls.push([file, args]), { code: 0, stdout: "" });
  assert.deepEqual(await openDeepLink("slack://open", { platform: "linux", run }), {
    opened: true,
    scheme: "slack",
  });
  assert.deepEqual(calls[0], ["xdg-open", ["slack://open"]]);
  assert.equal((await openDeepLink("file:///etc/passwd", { run })).opened, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(openerFor("darwin", "x:y"), { file: "open", args: ["x:y"] });
  assert.equal(openerFor("win32", "x:y").args.at(-1), "x:y");
  const mail = "mailto:?subject=a&body=b";
  const mailCalls = [];
  const mailRun = async (file, args) => (mailCalls.push([file, args]), { code: 0, stdout: "" });
  assert.deepEqual(await openDeepLink(mail, { platform: "win32", run: mailRun }), {
    opened: true,
    scheme: "mailto",
  });
  assert.deepEqual(mailCalls[0], ["rundll32.exe", ["url.dll,FileProtocolHandler", mail]]);
  assert.notEqual(mailCalls[0][0].toLowerCase(), "cmd.exe");
  assert.deepEqual(await openDeepLink(mail, { platform: "linux", run: mailRun }), {
    opened: true,
    scheme: "mailto",
  });
  assert.deepEqual(mailCalls[1], ["xdg-open", [mail]]);
  const failed = await openDeepLink("notion://p", {
    platform: "darwin",
    run: async () => ({ code: 1, stdout: "" }),
  });
  assert.equal(failed.opened, false);
});

test("the keychain probe reports availability per OS without reading a secret", async () => {
  const seen = [];
  const ok = async (file, args) => (seen.push([file, ...args].join(" ")), { code: 0, stdout: "" });
  assert.deepEqual(await probeKeychain({ platform: "darwin", run: ok }), {
    platform: "darwin",
    available: true,
    backend: "macos-keychain",
    tool: "security",
  });
  assert.equal(
    (await probeKeychain({ platform: "win32", run: ok })).backend,
    "windows-credential-manager",
  );
  const linux = await probeKeychain({
    platform: "linux",
    run: ok,
    env: { DBUS_SESSION_BUS_ADDRESS: "unix:x" },
  });
  assert.equal(linux.available, true);
  const noBus = await probeKeychain({ platform: "linux", run: ok, env: {} });
  assert.equal(noBus.available, false);
  assert.match(noBus.detail, /D-Bus/);
  const missing = await probeKeychain({
    platform: "linux",
    run: async () => ({ code: 127, stdout: "" }),
    env: {},
  });
  assert.match(missing.detail, /not installed/);
  assert.ok(
    seen.every((line) => !/find-generic|find-internet|lookup|dump|-w\b/.test(line)),
    seen.join("\n"),
  );
  // The real probe returns promptly whatever this machine has.
  const real = await probeKeychain();
  assert.equal(typeof real.available, "boolean");
});

test("the extension registry allows only registered peers and their message types", () => {
  const id = "a".repeat(32);
  const registry = new ExtensionCoopRegistry([
    { id, name: "Peer", messages: ["ping", "ping", "tab"] },
  ]);
  assert.equal(registry.canMessage(id, "ping"), true);
  assert.equal(registry.canMessage(id, "exec"), false);
  assert.equal(registry.canMessage("b".repeat(32), "ping"), false);
  assert.deepEqual(registry.get(id).messages, ["ping", "tab"]);
  registry.get(id).messages.push("exec");
  assert.equal(registry.canMessage(id, "exec"), false);
  assert.throws(() => registry.register({ id: "bad", name: "x", messages: [] }), /INVALID_INPUT/);
  assert.equal(registry.remove(id), true);
  assert.deepEqual(registry.list(), []);
});
