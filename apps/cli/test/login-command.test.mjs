// `aeon login` is Aeon's own command (browserkit has none), so it must reach the command list once.
import assert from "node:assert/strict";
import test from "node:test";
import { aeonCommands } from "../dist/commands.js";

test("aeon login is listed exactly once", () => {
  const names = aeonCommands({}).map((command) => command.name);
  assert.equal(names.filter((name) => name === "login").length, 1);
  assert.equal(new Set(names).size, names.length);
});
