// A document still loading can have no <html> lang, no <body>, or neither. The page-side readers
// must answer with empty data rather than throw a TypeError the agent sees as a broken tool.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/code-api-data.ts", import.meta.url), "utf8");

function pageFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `${name} is still a module-level page function`);
  return source.slice(start, end + 2);
}

function load(name, document) {
  const sandbox = {
    document,
    location: { href: "https://example.test/" },
    Object,
    Math,
    Number,
    Set,
  };
  return vm.runInNewContext(`${pageFunction(name)}\n${name}`, sandbox);
}

const empty = { querySelector: () => null, querySelectorAll: () => [] };

test("page metadata reads when the document has no root element", () => {
  const read = load("__readMetadata", { ...empty, title: "", documentElement: null });
  const meta = read();
  assert.equal(meta.lang, undefined);
  assert.equal(meta.url, "https://example.test/");
});

test("page metadata carries the html lang when there is one", () => {
  const read = load("__readMetadata", { ...empty, title: "t", documentElement: { lang: "en" } });
  assert.equal(read().lang, "en");
});

test("expanding collapsed content does nothing when there is no body", () => {
  const read = load("__expandRead", { ...empty, body: null });
  assert.equal(JSON.stringify(read({})), JSON.stringify({ clicked: [], skipped: [] }));
});
