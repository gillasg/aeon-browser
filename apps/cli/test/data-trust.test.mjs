import assert from "node:assert/strict";
import test from "node:test";
import { doctorChecks } from "../src/doctor-checks.ts";

test("doctor names an attacker-owned data directory and the one change that fixes it", () => {
  const checks = doctorChecks({
    daemon: undefined,
    chromeCommandLines: [],
    modelSignedIn: true,
    loginTask: true,
    dirs: [
      {
        name: "Graft",
        path: "/tmp/stolen",
        writable: true,
        trustError: "Refusing /tmp/stolen: it is owned by uid 65534, not 1000.",
        trustFix: "Set GRAFT_DATA_DIR to a directory you own with mode 700.",
      },
    ],
  });
  const data = checks.find((check) => check.name === "data");
  assert.equal(data.status, "fail");
  assert.match(data.detail, /owned by uid 65534/);
  assert.match(data.fix, /GRAFT_DATA_DIR/);
});
