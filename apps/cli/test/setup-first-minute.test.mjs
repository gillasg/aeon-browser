import assert from "node:assert/strict";
import test from "node:test";
import { firstSixtySeconds, setupPrompts } from "../dist/setup-prompts.js";

const deps = (answers, applied) => ({
  interactive: true,
  ask: async () => answers.shift() ?? "",
  say: () => undefined,
  applyFlags: () => {
    applied.push(true);
    return { done: true, detail: "ok" };
  },
  detectAgents: async () => [],
  connectAgents: async () => undefined,
  connectedModels: async () => 1,
  login: async () => 0,
});

test("the first minute points at live attach and MCP, never an unpublished npx command", () => {
  const text = firstSixtySeconds().join("\n");
  assert.match(text, /aeon map --attach active --until-idle 8/);
  assert.match(text, /aeon mcp/);
  assert.doesNotMatch(text, /npx/);
});

test("the Chrome flags offer is last, optional and skipped by Enter", async () => {
  const applied = [];
  const asked = await setupPrompts(deps([""], applied));
  assert.equal(applied.length, 0);
  assert.match(asked.at(-1), /Optional, reversible/);
  await setupPrompts(deps(["y"], applied));
  assert.equal(applied.length, 1);
});

test("non-interactive setup asks nothing and applies nothing", async () => {
  const applied = [];
  assert.deepEqual(await setupPrompts({ ...deps([], applied), interactive: false }), []);
  assert.equal(applied.length, 0);
});
