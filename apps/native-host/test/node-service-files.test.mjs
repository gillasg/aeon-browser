import assert from "node:assert/strict";
import test from "node:test";
import { launchAgent, serviceEnvironment, systemdUnit } from "../scripts/service-files.mjs";

const paths = { node: "/usr/bin/node", hostEntry: "/opt/Aeon Support/native-host.mjs" };

test("the install's data locations travel with the login service", () => {
  assert.deepEqual(serviceEnvironment({}), []);
  const env = { XDG_DATA_HOME: "/mnt/data", AEON_DATA_DIR: "/srv/aeon data" };
  assert.deepEqual(serviceEnvironment(env), [
    ["XDG_DATA_HOME", "/mnt/data"],
    ["AEON_DATA_DIR", "/srv/aeon data"],
  ]);

  const unit = systemdUnit({ ...paths, env });
  assert.match(unit, /Environment="XDG_DATA_HOME=\/mnt\/data"/);
  assert.match(unit, /Environment="AEON_DATA_DIR=\/srv\/aeon data"/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/Aeon Support\/native-host.mjs"/);

  const plist = launchAgent({ ...paths, root: "/home/user/Library/Application Support/Aeon", env });
  assert.match(
    plist,
    /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>XDG_DATA_HOME<\/key><string>\/mnt\/data<\/string>/,
  );
  assert.match(plist, /<key>AEON_DATA_DIR<\/key><string>\/srv\/aeon data<\/string>/);
});

test("a service without custom data locations carries no environment block", () => {
  const unit = systemdUnit({ ...paths, env: {} });
  assert.equal(unit.includes("Environment="), false);
  const plist = launchAgent({ ...paths, root: "/home/user", env: {} });
  assert.equal(plist.includes("EnvironmentVariables"), false);
});

test("unit values escape quotes, backslashes and percent signs", () => {
  const unit = systemdUnit({
    ...paths,
    env: { AEON_DATA_DIR: '/srv/a\\b"c%h' },
  });
  assert.ok(unit.includes('Environment="AEON_DATA_DIR=/srv/a\\\\b\\"c%%h"'), unit);
});
