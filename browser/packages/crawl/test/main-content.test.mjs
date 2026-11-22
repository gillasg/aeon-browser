import assert from "node:assert/strict";
import test from "node:test";
import { clean, mainHtml, toMarkdown } from "../dist/content/html.js";

function mainMarkdown(body) {
  const { doc } = clean(
    `<!doctype html><html><head><title>List</title></head><body>${body}</body></html>`,
    "http://site.test/",
    {},
  );
  return toMarkdown(mainHtml(doc));
}

test("a page of several article cards keeps every card and what follows them", () => {
  const cards = ["Alpha", "Bravo", "Charlie"]
    .map((name) => `<article class="card"><h3>${name}</h3><p>Room ${name}</p></article>`)
    .join("");
  const markdown = mainMarkdown(
    `<h1>Listing</h1>${cards}<table><tr><td>Delta</td></tr></table><dl><dt>Echo</dt><dd>Later</dd></dl>`,
  );
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"])
    assert.match(markdown, new RegExp(name));
});

test("a long page of article cards is not cut down to the one card Readability picks", () => {
  const filler =
    "Plenty of descriptive words about this entry so it reads like real content. ".repeat(4);
  const cards = ["Alpha", "Bravo", "Charlie", "Delta"]
    .map((name) => `<article><h3>${name}</h3><p>${name}: ${filler}</p></article>`)
    .join("");
  const markdown = mainMarkdown(`<h1>Listing</h1>${cards}`);
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta"])
    assert.match(markdown, new RegExp(`### ${name}`));
});

test("a single article is still the main content", () => {
  const markdown = mainMarkdown(
    `<nav><a href="/">Home nav</a></nav><article><h1>Story</h1><p>Body text.</p></article>`,
  );
  assert.match(markdown, /Story/);
  assert.doesNotMatch(markdown, /Home nav/);
});
