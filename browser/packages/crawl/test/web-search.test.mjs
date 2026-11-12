import assert from "node:assert/strict";
import test from "node:test";
import { searchWeb } from "../dist/index.js";

/** Answers every fetch with one Exa MCP tool result (one text for every hit) and records the URLs. */
function stubExa(t, text) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("a rule inside an Exa hit's own text does not cut the hit in two", async (t) => {
  const text = [
    "Title: First",
    "URL: https://first.example/a",
    "Published: 2026-01-01",
    "Highlights:",
    "Intro paragraph.",
    "",
    "---",
    "",
    "After the rule.",
    "",
    "---",
    "",
    "Title: Second",
    "URL: https://second.example/b",
    "Highlights:",
    "Second body.",
  ].join("\n");
  const calls = stubExa(t, text);

  const { provider, results } = await searchWeb("query", { provider: "exa" });

  assert.equal(provider, "exa");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /mcp\.exa\.ai/);
  assert.deepEqual(
    results.map((result) => result.url),
    ["https://first.example/a", "https://second.example/b"],
  );
  assert.equal(results[0].title, "First");
  assert.equal(results[0].content, "Intro paragraph.\n\n---\n\nAfter the rule.");
  assert.equal(results[1].content, "Second body.");
  for (const result of results) assert.doesNotMatch(result.content, /Title: Second/);
});

test("every hit with a rule keeps its own text, and no hit is invented", async (t) => {
  const hits = [0, 1, 2].map((index) => [
    `Title: Hit ${index}`,
    `URL: https://hit${index}.example/`,
    "Highlights:",
    `Lead ${index}.`,
    "",
    "---",
    "",
    `Tail ${index}.`,
  ]);
  const text = hits.map((hit) => hit.join("\n")).join("\n\n---\n\n");
  stubExa(t, text);

  const { results } = await searchWeb("query", { provider: "exa" });

  assert.deepEqual(
    results.map((result) => result.url),
    ["https://hit0.example/", "https://hit1.example/", "https://hit2.example/"],
  );
  for (const [index, result] of results.entries())
    assert.equal(result.content, `Lead ${index}.\n\n---\n\nTail ${index}.`);
});
