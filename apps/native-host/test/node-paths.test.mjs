import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { posix, win32 } from "node:path";
import test from "node:test";
import { appRoot, dataDirectory, hostPaths, runtimeDirectory, socketPath } from "../node/paths.mjs";

test("the app root follows each OS convention", () => {
  const home = "/home/tester";
  const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", XDG_DATA_HOME: "/xdg" };
  assert.equal(appRoot({ env, platform: "win32", home }), win32.join(env.LOCALAPPDATA, "Graft"));
  assert.equal(
    appRoot({ env, platform: "darwin", home }),
    posix.join(home, "Library", "Application Support", "Graft"),
  );
  assert.equal(appRoot({ env, platform: "linux", home }), posix.join("/xdg", "graft"));
  assert.equal(
    appRoot({ env: {}, platform: "linux", home }),
    posix.join(home, ".local", "share", "graft"),
  );
});

test("GRAFT_DATA_DIR wins and a bare home is expanded", () => {
  assert.equal(
    dataDirectory({
      env: { GRAFT_DATA_DIR: "/tmp/graft" },
      platform: "linux",
      home: "/home/tester",
    }),
    posix.resolve("/tmp/graft"),
  );
  assert.equal(
    dataDirectory({ env: { GRAFT_DATA_DIR: "~/data" }, platform: "linux", home: "/home/tester" }),
    posix.join("/home/tester", "data"),
  );
});

test("the bootstrap socket lives in a per-user runtime directory, not a shared /tmp file", () => {
  const home = "/home/tester";
  const linux = { env: { XDG_RUNTIME_DIR: "/run/user/1001" }, platform: "linux", home, uid: 1001 };
  assert.equal(runtimeDirectory(linux), "/run/user/1001/graft");
  assert.ok(socketPath(linux).startsWith("/run/user/1001/graft/"));
  assert.ok(socketPath(linux).length < 104, socketPath(linux));

  // Without XDG_RUNTIME_DIR, macOS and Linux use a private directory this user owns.
  for (const platform of ["linux", "darwin"]) {
    assert.equal(runtimeDirectory({ env: {}, platform, home, uid: 1001 }), "/tmp/graft-1001");
    const socket = socketPath({ env: {}, platform, home, uid: 1001 });
    assert.ok(socket.startsWith("/tmp/graft-1001/"), socket);
    assert.ok(socket.length < 104, socket);
  }
});

test(
  "macOS uses the per-user private temp dir for both host and supervisor",
  // The private-temp check is POSIX ownership and mode; a Windows temp dir cannot pass it.
  {
    skip: process.platform === "win32" ? "POSIX ownership checks; runs on macOS and Linux" : false,
  },
  () => {
    // The Chrome-launched host and the launchd supervisor both call hostPaths(); a single resolved
    // runtime directory is what makes them agree on the bootstrap socket.
    // Short and fixed: an ambient TMPDIR can be long enough to push the socket over 104 bytes.
    const privateTemp = mkdtempSync("/tmp/graft-mac-tmp-");
    try {
      const options = { env: { TMPDIR: privateTemp }, platform: "darwin", home: "/Users/tester" };
      const expected = posix.join(privateTemp, "graft");
      assert.equal(runtimeDirectory(options), expected);
      // The host and the supervisor both derive the socket from these paths.
      assert.ok(hostPaths(options).socket.startsWith(expected + "/"));
      assert.ok(hostPaths(options).socket.length < 104);
    } finally {
      rmSync(privateTemp, { recursive: true, force: true });
    }
  },
);

test("macOS falls back to owner-checked /tmp/<uid> when the private temp dir is unusable", () => {
  const home = "/Users/tester";
  for (const env of [{ TMPDIR: "/tmp" }, { TMPDIR: "/private/tmp" }, { TMPDIR: "/no/such/dir" }])
    assert.equal(runtimeDirectory({ env, platform: "darwin", home, uid: 1001 }), "/tmp/graft-1001");
});

test("GRAFT_RUNTIME_DIR is the override on every POSIX OS", () => {
  for (const platform of ["darwin", "linux"]) {
    const options = {
      env: {
        GRAFT_RUNTIME_DIR: "/custom/run",
        XDG_RUNTIME_DIR: "/run/user/1",
        TMPDIR: "/var/folders/private/T",
      },
      platform,
      home: "/home/tester",
      uid: 1001,
    };
    assert.equal(runtimeDirectory(options), "/custom/run/graft");
  }
});

test("the socket name stays short even under a long home", () => {
  const home = "/home/" + "very-long-name/".repeat(12);
  const socket = socketPath({ env: {}, platform: "darwin", home, uid: 1001 });
  assert.ok(socket.length < 104, socket);
  const longRuntime = "/run/user/" + "a".repeat(200);
  const fallback = socketPath({
    env: { XDG_RUNTIME_DIR: longRuntime },
    platform: "linux",
    home,
    uid: 1001,
  });
  assert.ok(fallback.startsWith("/tmp/graft-1001/"), fallback);
  assert.ok(fallback.length < 104, fallback);
});
