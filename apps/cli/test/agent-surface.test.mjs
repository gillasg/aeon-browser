import assert from "node:assert/strict";
import test from "node:test";
import { graftCommands } from "../dist/commands.js";
import { formatAgentSurface } from "../dist/agent-surface.js";

test("graft agent-surface is a command and prints the hash, prompt, tools and first turn", () => {
  const command = graftCommands({}).find((item) => item.name === "agent-surface");
  assert.ok(command);
  assert.match(command.help, /--json/);
  assert.match(command.help, /offline/);
  const text = formatAgentSurface({
    hash: "abc",
    systemPrompt: "Be brief.",
    tools: [
      { name: "browser_code", description: "Run JavaScript.", parameters: { type: "object" } },
    ],
    firstTurn: "Untrusted browser context.",
  });
  assert.match(text, /^hash abc/);
  assert.match(text, /Be brief\./);
  assert.match(text, /browser_code/);
  assert.match(text, /Untrusted browser context\./);
});
