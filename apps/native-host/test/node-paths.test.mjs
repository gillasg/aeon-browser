import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { appRoot, dataDirectory, runtimeDirectory, socketPath } from "../node/paths.mjs";

test("the app root follows each OS convention", () => {
  const home = "/home/tester";
  const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", XDG_DATA_HOME: "/xdg" };
  assert.equal(appRoot({ env, platform: "win32", home }), win32.join(env.LOCALAPPDATA, "Aeon"));
  assert.equal(
    appRoot({ env, platform: "darwin", home }),
    posix.join(home, "Library", "Application Support", "Aeon"),
  );
  assert.equal(appRoot({ env, platform: "linux", home }), posix.join("/xdg", "aeon"));
  assert.equal(
    appRoot({ env: {}, platform: "linux", home }),
    posix.join(home, ".local", "share", "aeon"),
  );
});

test("AEON_DATA_DIR wins and a bare home is expanded", () => {
  assert.equal(
    dataDirectory({ env: { AEON_DATA_DIR: "/tmp/aeon" }, platform: "linux", home: "/home/tester" }),
    posix.resolve("/tmp/aeon"),
  );
  assert.equal(
    dataDirectory({ env: { AEON_DATA_DIR: "~/data" }, platform: "linux", home: "/home/tester" }),
    posix.join("/home/tester", "data"),
  );
});

test("the bootstrap socket lives in a per-user runtime directory, not a shared /tmp file", () => {
  const home = "/home/tester";
  const linux = { env: { XDG_RUNTIME_DIR: "/run/user/1001" }, platform: "linux", home, uid: 1001 };
  assert.equal(runtimeDirectory(linux), "/run/user/1001/aeon");
  assert.ok(socketPath(linux).startsWith("/run/user/1001/aeon/"));
  assert.ok(socketPath(linux).length < 104, socketPath(linux));

  // Without XDG_RUNTIME_DIR, macOS and Linux use a private directory this user owns.
  for (const platform of ["linux", "darwin"]) {
    assert.equal(runtimeDirectory({ env: {}, platform, home, uid: 1001 }), "/tmp/aeon-1001");
    const socket = socketPath({ env: {}, platform, home, uid: 1001 });
    assert.ok(socket.startsWith("/tmp/aeon-1001/"), socket);
    assert.ok(socket.length < 104, socket);
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
  assert.ok(fallback.startsWith("/tmp/aeon-1001/"), fallback);
  assert.ok(fallback.length < 104, fallback);
});
