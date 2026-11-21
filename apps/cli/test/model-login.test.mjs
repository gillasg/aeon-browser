import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeStatus,
  extensionIdFromKey,
  loginUsage,
  modelLoginStatus,
} from "../dist/model-login-cmd.js";

test("the extension id comes from the manifest key the way Chrome derives it", () => {
  const id = extensionIdFromKey(Buffer.from("aeon test key").toString("base64"));
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, extensionIdFromKey(Buffer.from("aeon test key").toString("base64")));
  assert.notEqual(id, extensionIdFromKey(Buffer.from("another key").toString("base64")));
});

test("status says how to connect a model when there is none, and lists them when there are", () => {
  assert.match(describeStatus({ connected: [] }), /Run `aeon login`/);
  const text = describeStatus({
    connected: [
      { id: "anthropic", name: "Anthropic" },
      { id: "groq", name: "Groq", source: "GROQ_API_KEY" },
    ],
    defaultModel: "anthropic/claude-opus-5-5",
  });
  assert.match(text, /Anthropic\n {2}Groq \(from GROQ_API_KEY\)/);
  assert.match(text, /Default model: anthropic\/claude-opus-5-5/);
  assert.match(loginUsage, /aeon login status/);
});

test("status reads the default model from Pi's settings", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "aeon-cli-login-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.2-sol" }),
  );
  const status = await modelLoginStatus(agentDir);
  assert.ok(Array.isArray(status.connected));
  assert.equal(status.defaultModel, "openai/gpt-6.2-sol");
});
