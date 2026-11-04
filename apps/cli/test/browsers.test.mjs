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
