import assert from "node:assert/strict";
import test from "node:test";
import { createRedactor } from "../dist/redact.js";
import { inferSchema } from "../dist/infer/schema.js";
import { markdownReport } from "../dist/emit/report.js";
import { redactHarText } from "../../engine/dist/native-browser-network-format.js";
import { toMarkdown } from "../../crawl/dist/content/html.js";
import { diffLines } from "../../boosts/src/shared/diff.ts";

const hostile = `${"a@".repeat(500_000)}\n`;

function timed(run) {
  const started = performance.now();
  const value = run();
  return { ms: performance.now() - started, value: JSON.stringify(value) };
}

test("1 MB of hostile text is truncated under 200 ms", () => {
  assert.ok(hostile.length >= 1_000_000);
  const cases = [
    ["redact.text", () => createRedactor().text(hostile)],
    ["redactHarText", () => redactHarText(hostile)],
    ["toMarkdown", () => toMarkdown(hostile)],
    ["diffLines", () => diffLines(hostile, hostile)],
    ["inferSchema", () => inferSchema([hostile])],
    ["markdownReport", () => markdownReport({ title: hostile })],
  ];
  for (const [name, run] of cases) {
    const result = timed(run);
    assert.ok(result.ms < 200, `${name} took ${result.ms.toFixed(1)} ms`);
    assert.match(result.value, /truncated/, name);
  }
});

test("a short value is still redacted", () => {
  assert.match(createRedactor().text("send it to user@example.com"), /<email>/);
});
