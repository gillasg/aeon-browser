import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("an ability asked for by name without a site is found on the site that has it", async () => {
  const home = await mkdtemp(join(tmpdir(), "graft-ability-any-"));
  const prev = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = home;
  try {
    for (const [dir, site] of [
      ["shop.example", "shop.example"],
      ["10.1.2.3_8080", "10.1.2.3:8080"],
    ]) {
      await mkdir(join(home, "sites", dir, "abilities"), { recursive: true });
      await writeFile(
        join(home, "sites", dir, "model.json"),
        JSON.stringify({ site, operations: [], generatedAt: "2026-01-01T00:00:00.000Z" }),
      );
    }
    const { saveAbility } = await import("@browserkit/site-mapper");
    await saveAbility("10.1.2.3:8080", {
      name: "stockCount",
      description: "How many of an item are in stock",
      kind: "read",
      ways: [{ via: "page", url: "http://10.1.2.3:8080/", read: "text" }],
    }).catch(async () => {
      await writeFile(
        join(home, "sites", "10.1.2.3_8080", "abilities", "stockcount.json"),
        JSON.stringify({ name: "stockCount", kind: "read", ways: [] }),
      );
    });
    const { siteMapperTool } = await import("../dist/definitions.js");
    const listed = await siteMapperTool.run(
      { action: "ability", name: "stock_count", test: true },
      {},
    );
    const text = JSON.stringify(listed);
    assert.doesNotMatch(text, /Give the site/);
    const all = await siteMapperTool.run({ action: "ability" }, {});
    assert.ok(
      all.abilities.some((item) => item.site === "10.1.2.3:8080" && item.name === "stockCount"),
    );
    const none = await siteMapperTool.run({ action: "ability", name: "nothingLikeThis" }, {});
    assert.match(none.note, /no saved ability/);
  } finally {
    if (prev === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
