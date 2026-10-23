import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { externalToolDefinitions, runExternalTool } from "../dist/external-tools.js";
import { sessionChatId } from "../dist/site-browser.js";

test("outside agents get the chat tools, each session in its own runtime and workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = { sessionDirectory: join(root, "pi-sessions"), agentDirectory: undefined };
  const calls = [];
  const run = async (chatId, _toolCallId, input) => {
    calls.push({ chatId, code: input.codeCell.code });
    return JSON.stringify({ value: 3, output: "", steps: [] });
  };

  const tools = externalToolDefinitions(sessions, run);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["browser_code", "crawl", "site_mapper", "extract", "browser_tabs"],
  );
  for (const tool of tools) assert.ok(tool.inputSchema.properties.session, tool.name);
  assert.match(tools[0].description, /browser\.openTab/);

  const result = await runExternalTool(sessions, run, "browser_code", "research", {
    code: "1 + 2",
  });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /value: 3/);
  await runExternalTool(sessions, run, "browser_tabs", "research", {});
  assert.equal(calls[0].chatId, sessionChatId("external", "research"));
  assert.match(calls[1].code, /browser\.tabs\(\)/);
  assert.ok((await stat(join(root, "external", "research"))).isDirectory());
  await assert.rejects(runExternalTool(sessions, run, "nope", "research", {}), /Unknown tool/);
});
