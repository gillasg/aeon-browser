// The contract suite's own rules, enforced on its source so they cannot drift: no model SDK and
// no browser launcher is imported, and every URL it names is loopback or a reserved test name.
// A run is therefore offline and zero-LLM by construction, on every OS.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const self = "suite-guard.test.mjs";
const sources = readdirSync(here)
  .filter((name) => name.endsWith(".mjs") && name !== self)
  .map((name) => ({ name, text: readFileSync(join(here, name), "utf8") }));

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const ALLOWED_IMPORT = /^(?:node:|\.{1,2}\/|@browserkit\/)/;
const URL_LITERAL = /https?:\/\/([^/\s"'`)]+)/g;
const ALLOWED_HOST = /^(?:127\.0\.0\.1|localhost)(?=$|:)|(?:^|\.)(?:test|example\.test)(?::\d+)?$/;

function matches(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[0]);
}

test("the suite imports only Node builtins, its own helpers and @browserkit packages", () => {
  assert.ok(sources.length >= 5, "the suite has its test files");
  for (const { name, text } of sources)
    for (const specifier of matches(text, IMPORT))
      assert.match(specifier, ALLOWED_IMPORT, `${name} imports ${specifier}`);
});

test("no model SDK, provider client or browser launcher is named anywhere in the suite", () => {
  const forbidden =
    /anthropic|openai|generative-ai|ollama|pi-adapter|playwright|puppeteer|CHROME_PATH|chrome-for-testing/i;
  for (const { name, text } of sources)
    assert.equal(forbidden.test(text), false, `${name} names a forbidden dependency`);
});

test("every URL the suite names is loopback or a reserved test host", () => {
  for (const { name, text } of sources)
    for (const host of matches(text, URL_LITERAL))
      assert.match(host, ALLOWED_HOST, `${name} names ${host}`);
});
