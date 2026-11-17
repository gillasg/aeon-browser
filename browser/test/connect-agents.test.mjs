// A commented opencode.json is still a config. The edit keeps the comment and every other server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { connectAgents } from "../apps/bridge/dist/connect-agents.js";

const server = { name: "aeon", command: "/usr/bin/aeon", args: ["mcp"] };
const commented = `{
  // keep me
  "mcp": {
    "other": { "type": "local", "command": ["echo"], "enabled": true },
  },
}
`;

test("a commented opencode.json is edited in place and uninstall removes only aeon", async () => {
  const home = mkdtempSync(join(tmpdir(), "aeon-agents-"));
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  writeFileSync(path, commented);
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const added = await connectAgents(server, { home });
    const opencode = added.find((result) => result.agent === "opencode");
    assert.equal(opencode?.done, true);
    const text = readFileSync(path, "utf8");
    assert.match(text, /\/\/ keep me/);
    assert.match(text, /"other"/);
    assert.match(text, /"aeon"/);
    assert.match(text, /"type": "local"/);

    const removed = await connectAgents(server, { home, uninstall: true, agents: ["opencode"] });
    assert.equal(removed.find((result) => result.agent === "opencode")?.done, true);
    const after = readFileSync(path, "utf8");
    assert.match(after, /\/\/ keep me/);
    assert.match(after, /"other"/);
    assert.equal(after.includes('"aeon"'), false);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
  }
});

test("toml and yaml keep comments, a binary file is refused, and a pipe does not pick", async () => {
  const home = mkdtempSync(join(tmpdir(), "aeon-agents-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  const toml = join(home, ".codex", "config.toml");
  const yaml = join(home, ".hermes", "config.yaml");
  const broken = join(home, ".config", "opencode", "opencode.json");
  writeFileSync(toml, "# keep toml\n[other]\nkey = 1\n");
  writeFileSync(yaml, '# keep yaml\nmcp_servers:\n  other:\n    command: "echo"\n');
  writeFileSync(broken, "{\0");
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const added = await connectAgents(server, { home, agents: ["codex", "hermes", "opencode"] });
    assert.equal(added.find((result) => result.agent === "Codex")?.done, true);
    assert.equal(added.find((result) => result.agent === "Hermes")?.done, true);
    assert.equal(added.find((result) => result.agent === "opencode")?.done, false);
    assert.match(readFileSync(toml, "utf8"), /# keep toml/);
    assert.match(readFileSync(toml, "utf8"), /\[mcp_servers\.aeon\]/);
    assert.match(readFileSync(yaml, "utf8"), /# keep yaml/);
    assert.match(readFileSync(yaml, "utf8"), /aeon:/);
    assert.equal(readFileSync(broken).includes("\0"), true);

    await connectAgents(server, { home, agents: ["codex", "hermes"], uninstall: true });
    assert.equal(readFileSync(toml, "utf8").includes("[mcp_servers.aeon]"), false);
    assert.match(readFileSync(toml, "utf8"), /# keep toml/);
    assert.equal(readFileSync(yaml, "utf8").includes("aeon:"), false);
    assert.match(readFileSync(yaml, "utf8"), /# keep yaml/);

    const input = new PassThrough();
    const picked = await Promise.race([
      connectAgents(server, { home, pick: true, input, output: new PassThrough() }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("picker waited")), 500)),
    ]);
    assert.equal(picked[0].agent, "picker");
    assert.equal(picked[0].done, false);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
  }
});
