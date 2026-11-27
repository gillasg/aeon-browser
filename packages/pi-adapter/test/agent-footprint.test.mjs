// The always-on agent footprint: what every new chat's first request carries. Ceilings only go
// down. bash, read, write and edit stay always-on everywhere.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAgentSurface } from "../dist/agent-surface.js";

const KB = 1024;
const MACHINE = ["bash", "read", "write", "edit"];
const CORE = [...MACHINE, "browser_code", "browser_context", "tool_search", "ask_user"];
const CEILING = { core: 10 * KB, systemPrompt: 19.5 * KB, tools: 33.5 * KB, total: 52.5 * KB };
const bytes = (value) =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));

test("the always-on footprint stays under its ceilings", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graft-footprint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const surface = await buildAgentSurface({
    workingDirectory: join(root, "workspace"),
    agentDirectory: join(root, "agent"),
    sessionDirectory: join(root, "sessions"),
  });
  const size = new Map(surface.tools.map((tool) => [tool.name, bytes(tool)]));
  for (const name of CORE) assert.ok(size.has(name), `${name} is always on`);
  assert.ok(!size.has("pin_result"), "pin_result is gone");
  const core = CORE.reduce((sum, name) => sum + size.get(name), 0);
  const tools = [...size.values()].reduce((sum, value) => sum + value, 0);
  const systemPrompt = bytes(surface.systemPrompt);
  const measured = { core, systemPrompt, tools, total: systemPrompt + tools };
  for (const [part, ceiling] of Object.entries(CEILING))
    assert.ok(measured[part] <= ceiling, `${part}: ${measured[part]} B > ${ceiling} B`);
});
