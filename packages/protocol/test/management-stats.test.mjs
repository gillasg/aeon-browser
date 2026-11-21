import assert from "node:assert/strict";
import test from "node:test";
import { ManagementAbilitySchema, ManagementSiteSchema } from "../dist/management-dto.js";

const ability = {
  name: "find-product",
  site: "croma.com",
  kind: "read",
  ways: ["api"],
  inputs: [],
  stats: { runs: 3, failures: 1, lastOkAt: "2026-11-21T00:00:00.000Z", ways: { api: { runs: 3 } } },
  updatedAt: "2026-11-21T00:00:00.000Z",
};

test("saved ability stats with ways parse cleanly through the management DTO", () => {
  const parsed = ManagementAbilitySchema.parse(ability);
  assert.deepEqual(parsed.stats, { runs: 3, failures: 1, lastOkAt: "2026-11-21T00:00:00.000Z" });
  const site = ManagementSiteSchema.parse({
    site: "croma.com",
    operations: 1,
    updatedAt: "",
    health: "ok",
    session: false,
    sessionAccount: null,
    sessionSavedAt: null,
    recording: false,
    suggestions: [],
    abilities: [ability],
  });
  assert.equal(site.abilities[0].stats.ways, undefined);
});
