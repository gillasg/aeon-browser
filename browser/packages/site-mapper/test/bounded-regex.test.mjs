import assert from "node:assert/strict";
import test from "node:test";
import { boundedExec, boundedTest, validatePattern } from "../dist/bounded-regex.js";
import { resolveField, matchesFilters } from "../dist/recipe-map.js";
import { collectExpression } from "../dist/runtime/collect.js";
import { createRedactor } from "../dist/redact.js";

test("a catastrophic pattern is refused quickly instead of hanging", () => {
  const started = Date.now();
  assert.throws(
    () => boundedTest("(a+)+b", "a".repeat(30_000) + "!", { label: "field match" }),
    /took too long|budget/,
  );
  assert.ok(Date.now() - started < 2000, "refused without stalling the host");
});

test("over-long and invalid patterns are refused with a clear reason", () => {
  assert.throws(() => boundedTest("a".repeat(501), "x"), /over 500 characters/);
  assert.throws(() => boundedTest("[", "x"), /needs a valid regex/);
  assert.throws(() => validatePattern("x".repeat(501), { label: "field match" }), /field match/);
});

test("bounded exec keeps capture groups", () => {
  assert.deepEqual(boundedExec("(\\d+)-(\\d+)", "id 12-34"), ["12-34", "12", "34"]);
  assert.equal(boundedExec("nope", "id 12-34"), null);
});

test("record field and filter patterns go through the same bounds", () => {
  assert.throws(
    () => resolveField({ id: "a".repeat(30_000) + "!" }, { path: "id", pattern: "(a+)+b" }),
    /took too long|budget/,
  );
  assert.throws(
    () =>
      matchesFilters({ id: "a".repeat(30_000) + "!" }, [
        { field: "id", op: "regex", value: "(a+)+b" },
      ]),
    /took too long|budget/,
  );
  assert.throws(
    () => resolveField({ id: "x" }, { path: "id", pattern: "a".repeat(501) }),
    /over 500 characters/,
  );
});

test("collect expressions refuse unusable patterns before reaching the page", () => {
  assert.throws(
    () =>
      collectExpression({ row: "li", fields: { id: { selector: "a", match: "a".repeat(501) } } }),
    /field match pattern is over 500/,
  );
  assert.throws(
    () => collectExpression({ row: "li", fields: { id: { selector: "a", match: "[" } } }),
    /field match needs a valid regex/,
  );
  assert.doesNotThrow(() =>
    collectExpression({ row: "li", fields: { id: { selector: "a", match: "(\\d+)" } } }),
  );
});

test("custom redaction patterns are bounded", () => {
  assert.throws(
    () => createRedactor({ patterns: ["a".repeat(501)] }).text("x"),
    /over 500 characters/,
  );
  assert.throws(() => createRedactor({ patterns: ["["] }).text("x"), /needs a valid regex/);
});

test("a slow pattern on a weird localhost URL degrades instead of aborting the rebuild", async () => {
  const { filterExchanges } = await import("../dist/index.js");
  const slow = "^(a+)+$";
  const exchange = (url) => ({
    id: url,
    source: "live",
    method: "GET",
    url,
    status: 200,
    requestHeaders: { accept: "application/json" },
    responseHeaders: { "content-type": "application/json" },
    responseBody: "{}",
    startedAt: 0,
  });
  const urls = [
    "http://127.0.0.1/api/items?x=" + "a".repeat(40) + "!",
    "http://127.0.0.1:3773/api/items?x=" + "a".repeat(40) + "!",
  ];
  const result = filterExchanges(urls.map(exchange), { noise: ["(a+)+$", "["] });
  assert.equal(result.kept.length + result.noise.reduce((n, r) => n + r.count, 0), 2);
  assert.equal(createRedactor({ patterns: [slow] }).text("a".repeat(40) + "!"), "<redacted>");
});
