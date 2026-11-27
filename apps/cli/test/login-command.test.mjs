// `graft login` is Graft's own command (browserkit has none), so it must reach the command list once.
import assert from "node:assert/strict";
import test from "node:test";
import { graftCommands } from "../dist/commands.js";

test("graft login is listed exactly once", () => {
  const names = graftCommands({}).map((command) => command.name);
  assert.equal(names.filter((name) => name === "login").length, 1);
  assert.equal(new Set(names).size, names.length);
});
