import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAbility, runAbility, saveAbility } from "../dist/abilities.js";
import { siteCapabilities } from "../dist/site-capabilities.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-effects-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  const dir = join(root, "sites", "example.com");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "model.json"),
    JSON.stringify({
      site: "example.com",
      operations: [
        { id: "search", method: "GET", path: "/api/search", role: "read", params: [] },
        { id: "order", method: "POST", path: "/api/order", role: "action", params: [] },
        { id: "login", method: "POST", path: "/api/login", role: "auth", params: [] },
      ],
    }),
  );
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
    ways: [{ kind: "api", operation: "search" }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("writes are listed with explicit and suspected kinds, per way", async () => {
  await withHome(async () => {
    const saved = await saveAbility(
      base({
        ways: [
          { kind: "api", operation: "search" },
          {
            kind: "steps",
            steps: [
              {
                kind: "click",
                target: { role: "button", name: "Delete item" },
                expectRequest: { method: "POST", path: "/api/delete" },
              },
              {
                kind: "click",
                target: { role: "button", name: "Sign out" },
                expectRequest: { method: "GET", path: "/logout" },
              },
              { kind: "read", target: { role: "link", name: "Item" } },
            ],
          },
          {
            kind: "script",
            runtime: "node",
            code: "return await siteMapper.write('order', inputs)",
          },
          { kind: "page", collect: { row: "body", fields: {} } },
        ],
      }),
    );
    assert.deepEqual(
      saved.ability.writes.map((write) => write.kind),
      ["explicit", "suspected", "explicit"],
    );
    assert.equal(saved.ability.writes[0].method, "POST");
    assert.equal(saved.ability.writes[0].path, "/api/delete");
    assert.equal(saved.ability.writes[1].method, "GET");
    assert.equal(saved.ability.writes[1].path, "/logout");
    assert.equal(saved.ability.writes[2].via, "script");
  });
});

test("a write ability's commit operation is explicit from the site model", async () => {
  await withHome(async () => {
    const saved = await saveAbility(
      base({
        name: "order tea",
        kind: "write",
        ways: [{ kind: "api", operation: "order", commit: 0 }],
      }),
    );
    assert.deepEqual(saved.ability.writes, [
      {
        id: "api:order:0",
        kind: "explicit",
        what: "order",
        via: "api",
        step: 0,
        method: "POST",
        path: "/api/order",
      },
    ]);
  });
});

test("the inventory never gates a run", async () => {
  await withHome(async () => {
    const saved = await saveAbility(base());
    const stored = await readAbility("example.com", saved.ability.name);
    stored.ways = [
      {
        kind: "steps",
        steps: [
          {
            kind: "click",
            target: { role: "button", name: "Delete item" },
            expectRequest: { method: "POST", path: "/api/delete" },
          },
        ],
      },
    ];
    const again = await saveAbility(stored);
    assert.equal(again.ability.writes[0].kind, "explicit");
    const acted = [];
    const host = {
      call: async () => assert.fail("the api was not asked"),
      controls: async () => [{ role: "button", name: "Delete item" }],
      act: async (step) => {
        acted.push(step);
        return { ok: true };
      },
    };
    const run = await runAbility("example.com", "search", {}, { via: "steps", host });
    assert.equal(run.via, "steps");
    assert.equal(acted.length, 1);
  });
});

test("capabilities show the writes, and a stats save keeps them", async () => {
  await withHome(async () => {
    const saved = await saveAbility(
      base({ name: "order tea", kind: "write", ways: [{ kind: "api", operation: "order" }] }),
    );
    const caps = await siteCapabilities("example.com");
    assert.deepEqual(caps.abilities[0].writes, saved.ability.writes);
    const again = await saveAbility(saved.ability, { check: false });
    assert.deepEqual(again.ability.writes, saved.ability.writes);
  });
});
