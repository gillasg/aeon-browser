import assert from "node:assert/strict";
import test from "node:test";
import { testAbilityCases } from "../dist/ability-contract.js";

// A builder asked for "two tests with different inputs" wrote the same value twice, once with a
// trailing space. A total that does not echo its input then looked constant, and every build of
// a correct ability failed ("constant output: the result ignores its inputs").

const read = (tests) => ({ kind: "read", name: "overdueTotal", site: "a.test", ways: [], tests });

test("inputs that differ only by space or case are one question, not a constant result", async () => {
  const report = await testAbilityCases(
    read([
      { inputs: { asOf: "2026-11-22" }, expect: {} },
      { inputs: { asOf: " 2026-11-22 " }, expect: {} },
    ]),
    async () => ({ total: 4200, count: 3 }),
  );
  assert.equal(report.constant, false);
  assert.equal(report.ok, true);
});

test("really different inputs with one answer are still constant", async () => {
  const report = await testAbilityCases(
    read([
      { inputs: { asOf: "2026-11-22" }, expect: {} },
      { inputs: { asOf: "2026-12-31" }, expect: {} },
      { inputs: { asOf: "2026-12-31 " }, expect: {} },
    ]),
    async () => ({ total: 4200, count: 3 }),
  );
  assert.equal(report.constant, true);
  assert.equal(report.ok, false);
});
