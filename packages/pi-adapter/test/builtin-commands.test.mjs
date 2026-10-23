import assert from "node:assert/strict";
import test from "node:test";
import { builtinCommands } from "../dist/builtin-commands.js";

test("native command catalog comes from the pinned Pi SDK", async () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { BUILTIN_SLASH_COMMANDS } = await import(new URL("./core/slash-commands.js", entry).href);
  const commands = builtinCommands();
  assert.deepEqual(
    commands.map((command) => command.name),
    BUILTIN_SLASH_COMMANDS.map((command) => command.name),
  );
  assert.ok(commands.every((command) => command.kind === "builtin"));
  assert.ok(commands.some((command) => command.invocation === "/tree"));
  assert.ok(commands.some((command) => command.invocation === "/compact"));
});
