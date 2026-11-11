import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostsNamed, matchAbilities, scoreAbility } from "../dist/match.js";

test("the same site's other task is not a match", () => {
  const orders = { name: "orders", description: "list my orders", inputs: [] };
  assert.ok(scoreAbility("show my orders", orders) >= 0.5);
  assert.equal(scoreAbility("track a shipment", orders), 0);
  assert.equal(scoreAbility("read the reviews", orders), 0);
});

test("hosts named in the prompt are candidates", () => {
  assert.deepEqual(hostsNamed("open https://www.shop.example/orders and notes.md"), [
    "shop.example",
  ]);
});

test("matchAbilities lists the top ability and drops the near miss", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-match-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = home;
  try {
    const folder = join(home, "sites", "shop.example", "abilities");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "orders.json"),
      JSON.stringify(ability("orders", "list my orders")),
    );
    await writeFile(
      join(folder, "reviews.json"),
      JSON.stringify(ability("reviews", "read the reviews")),
    );
    const hit = await matchAbilities("show my orders on shop.example", ["shop.example"], 3);
    assert.deepEqual(
      hit.map((item) => item.name),
      ["orders"],
    );
    assert.equal(hit[0].does, "read");
    assert.equal(hit[0].call, "site.run('orders', {page})");
    const miss = await matchAbilities("track a shipment", ["shop.example"], 3);
    assert.deepEqual(miss, []);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
  }
});

function ability(name, description) {
  return {
    name,
    site: "shop.example",
    description,
    kind: "read",
    inputs: { type: "object", properties: {} },
    ways: [{ kind: "script", code: "return []", runtime: "page" }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
