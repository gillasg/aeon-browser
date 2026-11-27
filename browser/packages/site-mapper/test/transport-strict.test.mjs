import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTransportPreferences, siteMapper } from "../dist/index.js";

// Strict sites (sealed API keys, session CSRF, keys a plain client is refused for): the call goes
// through the live page, and the page is remembered so later calls skip the doomed direct try.

const SEALED = "graft-sealed:abc123def456";

function modelOf(site, params = []) {
  return {
    version: 1,
    site,
    title: site,
    generatedAt: new Date().toISOString(),
    origins: [`https://${site}`],
    security: [],
    operations: [
      {
        id: "suggest",
        summary: "Suggestions",
        method: "GET",
        origin: `https://${site}`,
        path: "/api/suggest",
        kind: "rest",
        params,
        responses: { 200: { mime: "application/json", schema: { type: "object" } } },
        role: "read",
        security: [],
        dependencies: [],
        confidence: 1,
        bucket: "high",
        flags: [],
        sampleCount: 1,
        sources: [],
        pageUrls: [`https://${site}/`],
        samples: [],
      },
    ],
    pages: [],
    channels: [],
    components: {},
    noise: [],
    stats: { exchanges: 1, kept: 1, captures: [] },
  };
}

async function withSite(t, model) {
  const root = await mkdtemp(join(tmpdir(), "strict-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, "sites", model.site);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "model.json"), JSON.stringify(model, null, 2));
}

function transport(name, answer) {
  return {
    name,
    calls: 0,
    sent: [],
    async send(request) {
      this.calls++;
      this.sent.push(request);
      return answer(request);
    },
  };
}

const reply = (json, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  json,
});

test("a sealed recorded key routes straight to the page and is never sent as a handle", async (t) => {
  const model = modelOf("stays.example", [
    { name: "x-airbnb-api-key", in: "header", required: true, constant: SEALED },
  ]);
  await withSite(t, model);
  const direct = transport("direct", () => reply({ error: "invalid_key" }, 401));
  const page = transport("page", () => reply({ ok: true }));
  const api = await siteMapper(model.site, { model, transports: { direct, page }, session: false });
  assert.deepEqual(await api.call("suggest", {}), { ok: true });
  assert.equal(direct.calls, 0);
  assert.equal(page.calls, 1);
  assert.ok(!JSON.stringify(page.sent).includes("graft-sealed:"));
  assert.equal((await readTransportPreferences(model.site)).suggest.transport, "page");
});

for (const [status, body] of [
  [401, { error_code: 401, error_message: "invalid_key" }],
  [403, { errors: [{ message: "Forbidden" }] }],
]) {
  test(`a direct ${status} is retried once in the page, and the page is used next time`, async (t) => {
    const model = modelOf(`strict${status}.example`);
    await withSite(t, model);
    const direct = transport("direct", () => reply(body, status));
    const page = transport("page", () => reply({ ok: true }));
    const api = await siteMapper(model.site, {
      model,
      transports: { direct, page },
      session: false,
    });
    assert.deepEqual(await api.call("suggest", {}), { ok: true });
    assert.equal(direct.calls, 1);
    assert.equal(page.calls, 1);
    assert.equal((await readTransportPreferences(model.site)).suggest.transport, "page");
    const again = await siteMapper(model.site, {
      model,
      transports: { direct, page },
      session: false,
    });
    assert.deepEqual(await again.call("suggest", {}), { ok: true });
    assert.equal(direct.calls, 1, "no second doomed direct call");
    assert.equal(page.calls, 2);
  });
}
