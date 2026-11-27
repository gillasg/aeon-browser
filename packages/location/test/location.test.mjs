import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { graftAppRoot, graftDataDirectory } from "../dist/index.js";

test("the app root follows each OS convention", () => {
  const home = "/home/tester";
  const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", XDG_DATA_HOME: "/xdg" };
  assert.equal(
    graftAppRoot({ env, platform: "win32", home }),
    win32.join(env.LOCALAPPDATA, "Graft"),
  );
  assert.equal(
    graftAppRoot({ env, platform: "darwin", home }),
    posix.join(home, "Library", "Application Support", "Graft"),
  );
  assert.equal(graftAppRoot({ env, platform: "linux", home }), posix.join("/xdg", "graft"));
  assert.equal(
    graftAppRoot({ env: {}, platform: "linux", home }),
    posix.join(home, ".local", "share", "graft"),
  );
});

test("GRAFT_DATA_DIR wins and a bare home is expanded", () => {
  assert.equal(
    graftDataDirectory({
      env: { GRAFT_DATA_DIR: "/tmp/graft" },
      platform: "linux",
      home: "/home/tester",
    }),
    posix.resolve("/tmp/graft"),
  );
  assert.equal(
    graftDataDirectory({
      env: { GRAFT_DATA_DIR: "~/data" },
      platform: "linux",
      home: "/home/tester",
    }),
    posix.join("/home/tester", "data"),
  );
  assert.equal(
    graftDataDirectory({ env: {}, platform: "darwin", home: "/Users/tester" }),
    posix.join("/Users/tester", "Library", "Application Support", "Graft", "data"),
  );
});
