import assert from "node:assert/strict";
import test from "node:test";
import { aeonCommands } from "../dist/commands.js";
import { formatBrowser } from "../dist/browsers.js";

test("aeon browsers is a command, and run documents --browser", () => {
  const commands = aeonCommands({});
  assert.ok(commands.some((command) => command.name === "browsers"));
  assert.match(commands.find((command) => command.name === "run").help, /--browser name/);
});

test("a browser line shows its short id, name, tabs and sites", () => {
  const line = formatBrowser({
    clientInstanceId: "7c2f4b1e-0d5a-4e8b-9a61-3f2b8c9d0e14",
    name: "eval",
    tabs: 3,
    sites: ["github.com", "news.ycombinator.com"],
  });
  assert.match(line, /^7c2f4b1e {2}eval\s+3 tabs {2}github\.com, news\.ycombinator\.com$/);
});

test("--browser pins every cell a command runs (boosts, map, cookies, record) to that profile", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "aeon-pin-"));
  const was = process.env.AEON_DATA_DIR;
  process.env.AEON_DATA_DIR = dir;
  try {
    const { DaemonHost } = await import("../dist/host.js");
    const sent = [];
    const host = new DaemonHost();
    host.connect = async () => ({
      browserRun: async (request) => (sent.push(request), { value: 1 }),
    });
    await host.runInBrowser("1");
    host.pinBrowser("recording");
    await host.runInBrowser("2", { session: "browserkit-cli" });
    await host.runInBrowser("3", { browser: "eval" });
    assert.equal(sent[0].browser, undefined);
    assert.equal(sent[1].browser, "recording");
    assert.equal(sent[2].browser, "eval");
    assert.equal(host.browser, "recording");
  } finally {
    if (was === undefined) delete process.env.AEON_DATA_DIR;
    else process.env.AEON_DATA_DIR = was;
    await rm(dir, { recursive: true, force: true });
  }
});

test("boosts, map, cookies and record document --browser", () => {
  const commands = aeonCommands({});
  for (const name of ["boosts", "map", "cookies", "record"]) {
    const command = commands.find((item) => item.name === name);
    assert.ok(command, name);
    assert.match(command.help, /--browser/, name);
  }
});
