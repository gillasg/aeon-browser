import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { aeonAppRoot, aeonDataDirectory } from "../dist/index.js";

test("the app root follows each OS convention", () => {
  const home = "/home/tester";
  const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", XDG_DATA_HOME: "/xdg" };
  assert.equal(aeonAppRoot({ env, platform: "win32", home }), win32.join(env.LOCALAPPDATA, "Aeon"));
  assert.equal(
    aeonAppRoot({ env, platform: "darwin", home }),
    posix.join(home, "Library", "Application Support", "Aeon"),
  );
  assert.equal(aeonAppRoot({ env, platform: "linux", home }), posix.join("/xdg", "aeon"));
  assert.equal(
    aeonAppRoot({ env: {}, platform: "linux", home }),
    posix.join(home, ".local", "share", "aeon"),
  );
});

test("AEON_DATA_DIR wins and a bare home is expanded", () => {
  assert.equal(
    aeonDataDirectory({
      env: { AEON_DATA_DIR: "/tmp/aeon" },
      platform: "linux",
      home: "/home/tester",
    }),
    posix.resolve("/tmp/aeon"),
  );
  assert.equal(
    aeonDataDirectory({
      env: { AEON_DATA_DIR: "~/data" },
      platform: "linux",
      home: "/home/tester",
    }),
    posix.join("/home/tester", "data"),
  );
  assert.equal(
    aeonDataDirectory({ env: {}, platform: "darwin", home: "/Users/tester" }),
    posix.join("/Users/tester", "Library", "Application Support", "Aeon", "data"),
  );
});
