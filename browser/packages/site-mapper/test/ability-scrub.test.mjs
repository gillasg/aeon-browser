import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, saveAbility } from "../dist/abilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-scrub-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function base(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: { type: "object", properties: {} },
    ways: [{ kind: "api", operation: "search", params: { q: "{{inputs.q}}" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const page = { kind: "page", collect: { row: "body", fields: {} } };

test("an api request that carried a secret is dropped, and the other way survives", async () => {
  await withHome(async (root) => {
    const saved = await saveAbility(
      base({
        inputs: { type: "object", properties: { token: { type: "string" } } },
        ways: [{ kind: "api", operation: "me", params: { token: "real-token-value" } }, page],
      }),
    );
    assert.equal(saved.ability.ways.length, 1);
    assert.deepEqual(
      saved.scrubbed.map((mark) => mark.what),
      ["api me"],
    );
    assert.equal(saved.scrubbed[0].dropped, true);
    assert.match(saved.warnings.join(" "), /api me was dropped: it carried a secret/);
    const stored = await readAbility("example.com", "search");
    assert.equal(
      stored.inputs.properties.token,
      undefined,
      "the input only the dropped way used is gone",
    );
    const file = await readFile(join(root, "sites/example.com/abilities/search.json"), "utf8");
    assert.ok(!file.includes("real-token-value"));
  });
});

test("an ability whose only request carried a secret is refused by name", async () => {
  await withHome(async () => {
    await assert.rejects(
      () =>
        saveAbility(
          base({
            ways: [{ kind: "api", operation: "login", params: { password: "hunter2000" } }],
          }),
        ),
      /ABILITY_ONLY_SECRET: example\.com search: api login carried a secret/,
    );
  });
});

test("a password typed into a step becomes a caller input with no example", async () => {
  await withHome(async (root) => {
    await saveAbility(
      base({
        ways: [
          {
            kind: "steps",
            steps: [
              { kind: "fill", target: { role: "textbox", name: "Password" }, args: ["hunter2000"] },
              { kind: "click", target: { role: "button", name: "Sign in" } },
            ],
          },
        ],
      }),
    );
    const stored = await readAbility("example.com", "search");
    assert.equal(stored.ways[0].steps[0].args[0], "{{inputs.password}}");
    assert.equal(stored.ways[0].redacted, true);
    assert.equal(stored.inputs.properties.password.example, undefined);
    assert.ok(stored.scrubbed.some((mark) => /steps: Password/.test(mark.what)));
    const file = await readFile(join(root, "sites/example.com/abilities/search.json"), "utf8");
    assert.ok(!file.includes("hunter2000"));
  });
});

test("a stored test case keeps its shape and loses the secret", async () => {
  await withHome(async (root) => {
    await saveAbility(
      base({
        inputs: { type: "object", properties: { q: { type: "string" } } },
        tests: [{ inputs: { q: "tea", password: "hunter2000" }, expect: { ok: true } }],
      }),
    );
    const stored = await readAbility("example.com", "search");
    assert.equal(stored.tests[0].redacted, true);
    assert.equal(stored.tests[0].inputs.password, "");
    assert.equal(stored.tests[0].inputs.q, "tea");
    const file = await readFile(join(root, "sites/example.com/abilities/search.json"), "utf8");
    assert.ok(!file.includes("hunter2000"));
  });
});

test("an email in the saved text is redacted and the way is kept", async () => {
  await withHome(async () => {
    await saveAbility(base({ description: "Contact demo@example.com for help" }));
    const stored = await readAbility("example.com", "search");
    assert.match(stored.description, /<email>/);
    assert.equal(stored.ways.length, 1);
    assert.equal(stored.scrubbed[0].reason, "personal");
  });
});

test("a stats save on a pre-existing secret keeps one redacted way instead of failing", async () => {
  await withHome(async (root) => {
    const folder = join(root, "sites/example.com/abilities");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "search.json"),
      JSON.stringify(
        base({ ways: [{ kind: "api", operation: "me", params: { token: "real-token-value" } }] }),
      ),
    );
    const before = await readAbility("example.com", "search");
    const saved = await saveAbility(before, { check: false });
    assert.equal(saved.ability.ways.length, 1);
    assert.equal(saved.ability.ways[0].redacted, true);
    assert.ok(!JSON.stringify(saved.ability).includes("real-token-value"));
    assert.equal(saved.scrubbed[0].dropped, false);
  });
});

test("an archived version is scrubbed too, so history keeps no secret", async () => {
  await withHome(async (root) => {
    const folder = join(root, "sites/example.com/abilities");
    const { mkdir, readdir, writeFile } = await import("node:fs/promises");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "search.json"),
      JSON.stringify(base({ description: "Contact demo@example.com for help" })),
    );
    const before = await readAbility("example.com", "search");
    await saveAbility({ ...before, description: "Contact the team" });
    const history = join(folder, ".history/search");
    const files = await readdir(history);
    assert.equal(files.length, 1, "the previous content was archived");
    const archived = await readFile(join(history, files[0]), "utf8");
    assert.ok(!archived.includes("demo@example.com"));
    assert.match(archived, /<email>/);
  });
});
