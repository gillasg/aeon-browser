// Built-in abilities: listed on their sites, replaced by a stored one of the same name, and the
// code written for each call parses, carries the inputs as data and says what it applied.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = await mkdtemp(join(tmpdir(), "builtin-abilities-"));
process.env.SITE_TO_API_HOME = home;
const { builtinAbilities, builtinSites, listAbilities, saveAbility, abilityPlan } =
  await import("../dist/index.js");

const parses = (code) => new Function(`return (${code});`);

test("AI sites and X have their built-in abilities", async () => {
  assert.deepEqual(
    (await listAbilities("chatgpt.com")).map((ability) => ability.name),
    ["ask"],
  );
  const gemini = builtinAbilities("https://gemini.google.com/app").map((ability) => ability.name);
  assert.deepEqual(gemini.sort(), ["ask", "ask_about_video", "edit_image", "make_image"]);
  assert.deepEqual(
    builtinAbilities("twitter.com")
      .map((ability) => ability.name)
      .sort(),
    ["research", "thread"],
  );
  assert.ok(builtinSites().includes("perplexity.ai"));
  assert.deepEqual(builtinAbilities("shop.example"), []);
  for (const ability of builtinAbilities("x.com")) assert.equal(ability.createdBy, "builtin");
});

test("every built-in's code parses, with the inputs as data", async () => {
  const cases = [
    ["chatgpt.com", "ask", { prompt: 'say "hi"\n`${x}`', effort: "pro", withPage: true }],
    ["gemini.google.com", "ask", { prompt: "hi", files: ["a.pdf"], model: "gemini-2.5-pro" }],
    ["perplexity.ai", "ask", { prompt: "hi", mode: "research" }],
    ["grok.com", "ask", { prompt: "hi", deepSearch: true, withPage: 12 }],
    ["kimi.com", "ask", { prompt: "hi", mode: "researcher" }],
    ["gemini.google.com", "make_image", { prompt: "a fox", aspectRatio: "16:9" }],
    ["gemini.google.com", "edit_image", { prompt: "make it blue", images: ["media/a.png"] }],
    ["gemini.google.com", "ask_about_video", { url: "https://youtu.be/dQw4w9WgXcQ" }],
    ["x.com", "thread", { url: "https://twitter.com/user/status/123" }],
    ["x.com", "research", { topic: "new phones", budget: 5, since: "2026-10-01" }],
  ];
  for (const [site, name, inputs] of cases) {
    const plan = await abilityPlan(site, name, inputs);
    assert.equal(plan.local, true, `${site} ${name} runs in the cell`);
    assert.equal(plan.opensOwnTab, true);
    assert.doesNotThrow(() => parses(plan.code), `${site} ${name} parses`);
  }
  const ask = await abilityPlan("chatgpt.com", "ask", { prompt: 'say "hi"', effort: "pro" });
  assert.match(ask.code, /model=gpt-5-pro/);
  assert.match(ask.code, /let askPrompt = "say \\"hi\\""/);
});

test("bad inputs fail before any tab opens", async () => {
  await assert.rejects(abilityPlan("chatgpt.com", "ask", {}), /INVALID_INPUT/);
  await assert.rejects(abilityPlan("gemini.google.com", "edit_image", { prompt: "x" }), /images/);
  await assert.rejects(abilityPlan("x.com", "thread", { url: "https://x.com/home" }), /post link/);
});

test("a stored ability of the same name replaces the built-in one", async () => {
  const now = new Date().toISOString();
  await saveAbility({
    name: "ask",
    site: "grok.com",
    kind: "read",
    description: "my own",
    inputs: { prompt: { type: "string" } },
    ways: [{ kind: "script", runtime: "node", code: "return { text: inputs.prompt };" }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "user",
    createdAt: now,
    updatedAt: now,
  });
  const listed = (await listAbilities("grok.com")).filter((ability) => ability.name === "ask");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].description, "my own");
  assert.equal((await abilityPlan("grok.com", "ask", { prompt: "x" })).local, false);
  await rm(home, { recursive: true, force: true });
});
