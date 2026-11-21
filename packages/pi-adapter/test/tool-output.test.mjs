import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { boundedResult, cutAtBoundary, fullOutput } from "../dist/site-tool-output.js";
import { aeonBridge, browserNamedFor, browserParentChat, inChat } from "../dist/site-browser.js";

function openString(text) {
  let inside = false;
  let escape = false;
  for (const char of text) {
    if (inside) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inside = false;
    } else if (char === '"') inside = true;
  }
  return inside;
}

test("a preview never ends inside a JSON string", () => {
  assert.equal(cutAtBoundary(`"${"y".repeat(30)}"`, 10), "");
  const object = `{"jobs":"${"x".repeat(40)}","ok":true}`;
  const cut = cutAtBoundary(object, 20);
  assert.ok(cut.length <= 20);
  assert.equal(openString(cut), false);
  assert.equal(cutAtBoundary(object, object.length), object);
});

test("a large result prints its path first, and --json keeps the whole value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aeon-out-"));
  const value = { jobs: "j".repeat(13_000) };
  const preview = await boundedResult(value, dir, "crawls", "jobs");
  const text = preview.content[0].text;
  assert.match(text.split("\n")[0], /^crawls\/jobs-/);
  assert.equal(text.includes("j".repeat(13_000)), false);
  const saved = await readFile(join(dir, text.split("\n")[0]), "utf8");
  assert.equal(JSON.parse(saved).jobs.length, 13_000);
  const full = await fullOutput(() => boundedResult(value, dir, "crawls", "jobs-full"));
  const parsed = JSON.parse(full.content[0].text);
  assert.equal(parsed.jobs.length, 13_000);
  assert.match(parsed.savedIn, /^crawls\/jobs-full-/);
});

test("a named browser is visible to the worker chat for the whole call", async () => {
  let seen;
  let parent;
  const bridge = aeonBridge(async (chatId) => {
    seen = browserNamedFor(chatId);
    parent = browserParentChat();
    return JSON.stringify({ value: 1 });
  });
  await inChat("parent-chat", () =>
    bridge.run("1", { session: "browser-crawl-1", browser: "recording" }),
  );
  assert.equal(seen, "recording");
  assert.equal(parent, "parent-chat");
  assert.equal(browserNamedFor("later"), undefined);
});
