import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { appRoot, dataDirectory } from "../node/paths.mjs";

test("the app root follows each OS convention", () => {
  const home = "/home/tester";
  const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", XDG_DATA_HOME: "/xdg" };
  assert.equal(appRoot({ env, platform: "win32", home }), join(env.LOCALAPPDATA, "Aeon"));
  assert.equal(
    appRoot({ env, platform: "darwin", home }),
    "/home/tester/Library/Application Support/Aeon",
  );
  assert.equal(appRoot({ env, platform: "linux", home }), "/xdg/aeon");
  assert.equal(appRoot({ env: {}, platform: "linux", home }), "/home/tester/.local/share/aeon");
});

test("AEON_DATA_DIR wins and a bare home is expanded", () => {
  assert.equal(
    dataDirectory({ env: { AEON_DATA_DIR: "/tmp/aeon" }, platform: "linux", home: "/home/tester" }),
    "/tmp/aeon",
  );
  assert.equal(
    dataDirectory({ env: { AEON_DATA_DIR: "~/data" }, platform: "linux", home: "/home/tester" }),
    "/home/tester/data",
  );
});
