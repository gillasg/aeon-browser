import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { doctorChecks } from "../src/doctor-checks.ts";
import { notRunningMessage, startFailureOf } from "../src/start-failure.ts";

test("a failed daemon start is reported, and status does not invent a session", () => {
  const checks = doctorChecks({
    daemon: undefined,
    chromeCommandLines: [],
    modelSignedIn: true,
    loginTask: true,
    dirs: [{ name: "Graft", path: "/tmp/graft", writable: true }],
    startError: "Refusing /tmp/graft: it is owned by uid 65534, not 1000.",
  });
  const daemon = checks.find((check) => check.name === "daemon");
  assert.equal(daemon.status, "fail");
  assert.match(daemon.detail, /owned by uid 65534/);
  assert.match(daemon.fix, /Chrome with Graft/);
  assert.equal(startFailureOf({ state: "ready", error: "old cause" }), undefined);
  assert.equal(startFailureOf({ state: "restarting", error: "  " }), undefined);
  assert.match(notRunningMessage("owned by uid 65534"), /Last start failed: owned by uid 65534/);
  assert.equal(notRunningMessage(undefined).includes("Last start failed"), false);
  const status = readFileSync(new URL("../src/browser-commands.ts", import.meta.url), "utf8");
  const body = status.slice(
    status.indexOf("async function status"),
    status.indexOf("async function tabs"),
  );
  assert.equal(body.includes("spawn"), false);
  assert.equal(body.includes("ensureBridge"), false);
});
