import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  browserProfileGuard,
  CREDENTIAL_REFUSAL,
  resolveProtectedTarget,
  shellTouchesCredentials,
} from "../dist/browser-profile-guard.js";
import {
  bwrapArgs,
  detectSandboxBackend,
  sandboxStatus,
  scrubSandboxEnv,
  seatbeltProfile,
  sensitivePaths,
  wrapSandboxedCommand,
} from "../dist/os-sandbox.js";
import { gatedBashTool, gateShellSpawn } from "../dist/shell-gate.js";

test("the catalog covers browser profiles, keychains and credential stores on each OS", () => {
  const mac = sensitivePaths("/Users/u", "darwin", { env: {} });
  for (const path of [
    "/Users/u/Library/Application Support/Google/Chrome",
    "/Users/u/Library/Keychains",
    "/Users/u/.ssh",
    "/Users/u/.aws",
    "/Users/u/Library/Application Support/Aeon/data/core-connection.json",
  ])
    assert.ok(mac.includes(path), path);
  assert.ok(
    !mac.includes("/Users/u/Library/Application Support/Aeon/data"),
    "workspaces stay open",
  );
  const linux = sensitivePaths("/home/u", "linux", { env: {} });
  assert.ok(linux.includes("/home/u/.config/google-chrome"));
  assert.ok(linux.includes("/home/u/.pi/agent/auth.json"));
  const win = sensitivePaths("C:\\Users\\u", "win32", { env: {} });
  assert.ok(win.includes("C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data"));
  assert.ok(win.includes("C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Credentials"));
  assert.ok(win.includes("C:\\Users\\u\\AppData\\Local\\Microsoft\\Credentials"));
});

test("the Seatbelt profile allows by default and denies each sensitive path, escaped", () => {
  const profile = seatbeltProfile([
    ...sensitivePaths("/Users/u", "darwin", { env: {} }),
    '/Users/u/we"ird\\dir',
  ]);
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-read\* file-write\*/);
  assert.ok(profile.includes('(subpath "/Users/u/Library/Application Support/Google/Chrome")'));
  assert.ok(profile.includes('(subpath "/Users/u/Library/Keychains")'));
  assert.ok(profile.includes('(subpath "/Users/u/.ssh")'));
  assert.ok(profile.includes('(subpath "/Users/u/.aws")'));
  assert.ok(profile.includes('(subpath "/Users/u/we\\"ird\\\\dir")'));
});

test("bwrap masks existing sensitive folders with tmpfs and keeps the working folder", () => {
  const kinds = { "/h/.ssh": "dir", "/h/.netrc": "file" };
  const args = bwrapArgs(["/h/.ssh", "/h/.netrc", "/h/.aws"], "/work", (p) => kinds[p]);
  assert.deepEqual(args, [
    "--bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/h/.ssh",
    "--ro-bind",
    "/dev/null",
    "/h/.netrc",
    "--chdir",
    "/work",
  ]);
  const wrapped = wrapSandboxedCommand("echo 'hi'", {
    cwd: "/work",
    status: { backend: "bwrap", active: true },
    paths: [],
  });
  assert.match(wrapped, /^exec 'bwrap' .* '--' 'bash' '-c' 'echo '\\''hi'\\'''$/);
  assert.equal(
    wrapSandboxedCommand("ls", { cwd: "/", status: { backend: "guard-only", active: false } }),
    "ls",
  );
});

test("the shell environment loses secrets and keeps path, home and proxy", () => {
  const env = scrubSandboxEnv({
    PATH: "/bin",
    HOME: "/h",
    TMPDIR: "/tmp",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "localhost",
    EXAMPLE_API_KEY: "x",
    SOME_SECRET: "x",
    DB_PASSWORD: "x",
    GH_TOKEN: "x",
    GITHUB_TOKEN: "x",
    AWS_ACCESS_KEY_ID: "x",
    AWS_SESSION_TOKEN: "x",
    NPM_TOKEN: "x",
    EDITOR: "vi",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "EDITOR",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "PATH",
    "TMPDIR",
  ]);
  const gated = gateShellSpawn({ command: "true", cwd: "/", env: { PATH: "/bin", X_TOKEN: "s" } });
  assert.equal(gated.env.X_TOKEN, undefined);
  assert.equal(gated.env.PATH, "/bin");
});

test("file tools cannot reach a profile or key through a symlink; normal files pass", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aeon-sandbox-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, "home", "Google", "Chrome", "User Data");
  const ssh = join(root, "home", ".ssh");
  mkdirSync(join(profile, "Default"), { recursive: true });
  mkdirSync(ssh, { recursive: true });
  writeFileSync(join(profile, "Default", "Login Data"), "secret");
  writeFileSync(join(ssh, "id_rsa"), "key");
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "notes.md"), "ok");
  const dirLink = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(join(profile, "Default"), join(work, "innocent"), dirLink);
  symlinkSync(join(ssh, "id_rsa"), join(work, "key.txt"), "file");
  const protect = [profile, ssh];
  for (const tool of ["read", "write", "edit"]) {
    assert.ok(resolveProtectedTarget(tool, { path: "innocent/Login Data" }, work, protect), tool);
    assert.ok(resolveProtectedTarget(tool, { file_path: "key.txt" }, work, protect), tool);
    assert.ok(resolveProtectedTarget(tool, { path: join(ssh, "new") }, work, protect), tool);
    assert.equal(resolveProtectedTarget(tool, { path: "notes.md" }, work, protect), undefined);
    assert.equal(resolveProtectedTarget(tool, { path: "fresh/new.md" }, work, protect), undefined);
  }
});

test("protected roots given through a symlinked parent still catch symlinked targets", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aeon-sandbox-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirLink = process.platform === "win32" ? "junction" : "dir";
  const profile = join(root, "home", "Google", "Chrome", "User Data");
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(join(profile, "Default", "Login Data"), "secret");
  const alias = join(root, "alias-home");
  symlinkSync(join(root, "home"), alias, dirLink);
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "notes.md"), "ok");
  symlinkSync(join(profile, "Default"), join(work, "innocent"), dirLink);
  const protect = [join(alias, "Google", "Chrome", "User Data")];
  assert.ok(resolveProtectedTarget("read", { path: "innocent/Login Data" }, work, protect));
  assert.ok(resolveProtectedTarget("read", { path: join(profile, "Default") }, work, protect));
  assert.equal(resolveProtectedTarget("read", { path: "notes.md" }, work, protect), undefined);
});

test("shell commands naming credential stores are refused; ordinary work is not", () => {
  for (const command of [
    "cat ~/.ssh/id_rsa",
    "cp $HOME/.aws/credentials /tmp/x",
    "ls /Users/me/Library/Keychains",
    "type C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\x",
  ])
    assert.equal(shellTouchesCredentials("bash", { command }), true, command);
  for (const command of ["ls ~/Downloads", "cat /tmp/x.txt", "npm test", "git status", "ssh -V"])
    assert.equal(shellTouchesCredentials("bash", { command }), false, command);
  let handler;
  browserProfileGuard("/").factory({ on: (_event, fn) => (handler = fn) });
  assert.deepEqual(handler({ toolName: "bash", input: { command: "cat ~/.ssh/id_rsa" } }), {
    block: true,
    reason: CREDENTIAL_REFUSAL,
  });
});

test("bash, read, write and edit stay on: everyday calls pass the guard", () => {
  let handler;
  browserProfileGuard(tmpdir()).factory({ on: (_event, fn) => (handler = fn) });
  assert.equal(handler({ toolName: "bash", input: { command: "ls -la" } }), undefined);
  assert.equal(handler({ toolName: "read", input: { path: "README.md" } }), undefined);
  assert.equal(handler({ toolName: "write", input: { path: "out.md", content: "x" } }), undefined);
  assert.equal(handler({ toolName: "edit", input: { path: "out.md", edits: [] } }), undefined);
  const settings = { getShellCommandPrefix: () => undefined, getShellPath: () => undefined };
  assert.equal(gatedBashTool(tmpdir(), settings).name, "bash");
});

test("AEON_OS_SANDBOX=0 turns the kernel sandbox off", () => {
  assert.deepEqual(detectSandboxBackend({ env: { AEON_OS_SANDBOX: "0" } }), {
    backend: "guard-only",
    active: false,
    reason: "AEON_OS_SANDBOX=0",
  });
});

test("a real sandboxed command runs and cannot read a masked folder", (t) => {
  const status = sandboxStatus();
  if (!status.active) return t.skip(`no kernel sandbox here: ${status.reason}`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aeon-sandbox-real-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hidden = join(root, "secret");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "key"), "TOPSECRET");
  const command = wrapSandboxedCommand(`echo ran; cat ${JSON.stringify(join(hidden, "key"))}`, {
    cwd: root,
    status,
    paths: [hidden],
  });
  const result = spawnSync("bash", ["-c", command], { cwd: root, encoding: "utf8" });
  assert.match(result.stdout, /ran/);
  assert.doesNotMatch(result.stdout, /TOPSECRET/);
});
