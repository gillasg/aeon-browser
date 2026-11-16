import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTransportPreferences, recordTransportPreference, siteMapper } from "../dist/index.js";

// A one-operation model whose recorded answer has two required fields. A transport is any object
// with a name and send(), so the tests can make each tier answer as they need.
function modelOf(site = "shop.example") {
  return {
    version: 1,
    site,
    title: "Shop",
    generatedAt: new Date().toISOString(),
    origins: [`https://${site}`],
    security: [],
    operations: [
      {
        id: "list",
        summary: "List things",
        method: "GET",
        origin: `https://${site}`,
        path: "/api/list",
        kind: "rest",
        params: [],
        responses: {
          200: {
            mime: "application/json",
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" }, items: { type: "array" } },
              required: ["ok", "items"],
            },
          },
        },
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

// Preferences live beside a mapped site, so each test writes the model a real mapped site has.
async function withSite(t, run) {
  const root = await mkdtemp(join(tmpdir(), "transport-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const model = modelOf();
  const dir = join(root, "sites", model.site);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "model.json"), JSON.stringify(model, null, 2));
  return run(root, model);
}

function transport(name, answer) {
  return {
    name,
    calls: 0,
    async send() {
      this.calls++;
      return answer();
    },
  };
}

function reply(json, status = 200) {
  return { status, headers: { "content-type": "application/json" }, json };
}

test("a direct answer that changed shape is retried in the page and remembered", async (t) => {
  await withSite(t, async (_root, model) => {
    const direct = transport("direct", () => reply({ surprise: true }));
    const page = transport("page", () => reply({ ok: true, items: [] }));
    const api = await siteMapper(model.site, {
      model,
      transports: { direct, page },
      session: false,
    });
    const first = await api.list();
    assert.equal(first.ok, true, "the page answered");
    assert.equal(first.items.length, 0);
    assert.match(first.notes.join(" "), /did not match the recorded shape/);
    const learned = await readTransportPreferences(model.site);
    assert.equal(learned.list.transport, "page");

    // The next client starts from the learned tier: the page, without trying direct first.
    const again = transport("direct", () => assert.fail("direct was preferred last time"));
    const pageAgain = transport("page", () => reply({ ok: true, items: [1] }));
    const apiAgain = await siteMapper(model.site, {
      model,
      transports: { direct: again, page: pageAgain },
      session: false,
    });
    const second = await apiAgain.list();
    assert.equal(second.items.length, 1);
    assert.equal(again.calls, 0);
    assert.equal(pageAgain.calls, 1);
  });
});

test("a drifted direct answer survives a page retry that is signed out or failing", async (t) => {
  for (const status of [401, 500]) {
    await withSite(t, async (_root, model) => {
      const direct = transport("direct", () => reply({ surprise: true }));
      const page = transport("page", () => reply({ error: "no" }, status));
      const api = await siteMapper(model.site, {
        model,
        transports: { direct, page },
        retries: 0,
        session: false,
      });
      const answer = await api.list();
      assert.equal(answer.surprise, true, `the direct 2xx is kept over a ${status}`);
      assert.match(answer.notes.join(" "), /kept, unverified/);
      assert.match(answer.notes.join(" "), /did not match the recorded shape/);
    });
  }
});

test("a transport error moves no preference", async (t) => {
  await withSite(t, async (_root, model) => {
    const direct = transport("direct", () => {
      throw new Error("ECONNRESET: socket hang up");
    });
    const page = transport("page", () => reply({ ok: true, items: [] }));
    const api = await siteMapper(model.site, {
      model,
      transports: { direct, page },
      retries: 0,
      session: false,
    });
    assert.equal((await api.list()).ok, true);
    assert.deepEqual(await readTransportPreferences(model.site), {});
  });
});

test("a 401 retried in the page remembers the page for next time", async (t) => {
  await withSite(t, async (_root, model) => {
    const direct = transport("direct", () => reply({ error: "signed out" }, 401));
    const page = transport("page", () => reply({ ok: true, items: [] }));
    const api = await siteMapper(model.site, {
      model,
      transports: { direct, page },
      session: false,
    });
    assert.equal((await api.list()).ok, true);
    assert.equal((await readTransportPreferences(model.site)).list.transport, "page");
  });
});

test("an explicit transport still wins over the learned one", async (t) => {
  await withSite(t, async (_root, model) => {
    await recordTransportPreference(model.site, "list", "page");
    const direct = transport("direct", () => reply({ ok: true, items: ["direct"] }));
    const page = transport("page", () => assert.fail("page was not named"));
    const api = await siteMapper(model.site, {
      model,
      transport: "direct",
      transports: { direct, page },
      session: false,
    });
    assert.deepEqual((await api.list()).items, ["direct"]);
    assert.equal(page.calls, 0);
    assert.equal(
      (await readTransportPreferences(model.site)).list.transport,
      "page",
      "an explicit choice is not learned",
    );
  });
});

test("preferences live beside the site, and a broken file means none", async (t) => {
  await withSite(t, async (root) => {
    await recordTransportPreference("shop.example", "list", "direct");
    const file = join(root, "sites", "shop.example", "transport.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.list.transport, "direct");
    assert.ok(stored.list.at);
    await rm(file);
    assert.deepEqual(await readTransportPreferences("shop.example"), {});
  });
});
