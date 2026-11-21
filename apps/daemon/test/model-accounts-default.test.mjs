import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { suggestDefaultModel } from "../dist/model-accounts/catalog.js";
import { LoginService } from "../dist/model-accounts/service.js";
import { openModelLogin } from "../dist/model-login.js";

const model = (provider, id) => ({ provider, id, name: id });

test("a first default prefers the provider just connected, on Pi's own default for it", () => {
  const available = [
    model("openrouter", "some/model"),
    model("anthropic", "claude-haiku-5-5"),
    model("anthropic", "claude-opus-5-5"),
  ];
  assert.deepEqual(suggestDefaultModel(available, "anthropic"), {
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  assert.deepEqual(suggestDefaultModel(available, "openrouter"), {
    provider: "openrouter",
    model: "some/model",
  });
  // Without a hint the popular providers come first.
  assert.equal(suggestDefaultModel(available)?.provider, "anthropic");
  assert.deepEqual(suggestDefaultModel([model("tiny", "t-1")]), { provider: "tiny", model: "t-1" });
  assert.equal(suggestDefaultModel([]), undefined);
});

function serviceWith(available, t) {
  const agentDir = mkdtempSync(join(tmpdir(), "aeon-default-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const models = {
    getAvailable: async () => available,
    getProviders: () => [],
    getModel: (provider, id) => available.find((m) => m.provider === provider && m.id === id),
  };
  return { service: new LoginService({ agentDir, models }), agentDir };
}

const settingsOf = (agentDir) => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));

test("signing in with no default sets one, so chats and the CLI work right away", async (t) => {
  const { service, agentDir } = serviceWith([model("openai", "gpt-6.2-sol")], t);
  assert.deepEqual(await service.ensureDefaultModel("openai"), {
    provider: "openai",
    model: "gpt-6.2-sol",
  });
  const settings = settingsOf(agentDir);
  assert.equal(settings.defaultProvider, "openai");
  assert.equal(settings.defaultModel, "gpt-6.2-sol");
});

test("a default that still works is left alone; one that stopped working is replaced", async (t) => {
  const { service, agentDir } = serviceWith(
    [model("anthropic", "claude-opus-5-5"), model("openai", "gpt-6.2-sol")],
    t,
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.2-sol", theme: "dark" }),
  );
  assert.equal(await service.ensureDefaultModel("anthropic"), undefined);
  assert.equal(settingsOf(agentDir).defaultProvider, "openai");

  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "gone", defaultModel: "old", theme: "dark" }),
  );
  assert.equal((await service.ensureDefaultModel())?.provider, "anthropic");
  assert.equal(settingsOf(agentDir).theme, "dark", "other settings are kept");
});

test("every caller of the sign-in service hears its changes, not only the first", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "aeon-pi-"));
  let first = 0;
  let second = 0;
  const url = await openModelLogin(agentDir, () => first++);
  assert.equal(
    await openModelLogin(agentDir, () => second++),
    url,
    "the running service is reused",
  );
  const token = new URL(url).hash.slice("#token=".length);
  const post = (path, body) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: { "x-aeon-login-token": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  t.after(async () => {
    await post("/api/done", {}).catch(() => undefined);
    rmSync(agentDir, { recursive: true, force: true });
  });
  assert.equal((await post("/api/default-model", {})).status, 200);
  assert.ok(first >= 1 && second >= 1, `both listeners ran (${first}, ${second})`);
});
