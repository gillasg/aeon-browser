import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

async function load() {
  const directory = await mkdtemp(fileURLToPath(new URL("./.viewer-files-", import.meta.url)));
  const out = join(directory, "viewer-files.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/viewer-files.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: out,
    logLevel: "silent",
  });
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const files = await load();
const base = "chrome-extension://abc/viewer.html";

test("a deep link round-trips path, line and diff", () => {
  const href = files.viewerHref(base, { chatId: "c1", path: "/w/a b.ts", line: 12, diff: "d1" });
  assert.deepEqual(files.parseViewerHref(href), {
    chatId: "c1",
    path: "/w/a b.ts",
    line: 12,
    diff: "d1",
  });
  assert.equal(files.parseViewerHref(base), undefined);
});

test("file clicks reuse the one open Viewer tab, preferring this window", () => {
  const tabs = [
    { id: 1, url: "chrome-extension://abc/chat.html?chatId=c1", windowId: 1 },
    { id: 2, url: base + "?chatId=c1&path=/a", windowId: 2, lastAccessed: 9 },
    { id: 3, url: base + "?chatId=c2&path=/b", windowId: 1, lastAccessed: 1 },
    { id: 4, url: "chrome-extension://other/viewer.html?path=/x", windowId: 1 },
  ];
  assert.equal(files.pickViewerTab(tabs, base, 1).id, 3);
  assert.equal(files.pickViewerTab(tabs, base, 5).id, 2);
  assert.equal(files.pickViewerTab(tabs.slice(0, 1), base, 1), undefined);
});

test("the recent strip keeps each file once, newest first, capped", () => {
  let list = [];
  for (let i = 0; i < 10; i++) list = files.pushRecent(list, { chatId: "c", path: "/f" + i }, i);
  assert.equal(list.length, files.RECENT_MAX);
  assert.equal(list[0].path, "/f9");
  list = files.pushRecent(list, { chatId: "c", path: "/f5", line: 3 }, 20);
  assert.equal(list[0].path, "/f5");
  assert.equal(list[0].line, 3);
  assert.equal(list.filter((item) => item.path === "/f5").length, 1);
  assert.deepEqual(files.readRecent([{ chatId: 1 }, null, { chatId: "c", path: "/p" }]), [
    { chatId: "c", path: "/p", openedAt: 0 },
  ]);
  assert.deepEqual(files.readRecent("nope"), []);
});

test("previews: markdown, CSV, HTML and SVG get one; code does not", () => {
  assert.equal(files.previewKind("/a/README.md", "markdown"), "markdown");
  assert.equal(files.previewKind("/a/data.TSV", "plaintext"), "csv");
  assert.equal(files.previewKind("/a/page.html", "html"), "html");
  assert.equal(files.previewKind("/a/logo.svg", "xml"), "image");
  assert.equal(files.previewKind("/a/main.ts", "typescript"), "none");
});

test("CSV reader handles quotes, doubled quotes and CRLF", () => {
  assert.deepEqual(files.parseDelimited('a,b\r\n"x, y","say ""hi"""\n1,'), [
    ["a", "b"],
    ["x, y", 'say "hi"'],
    ["1", ""],
  ]);
  assert.deepEqual(files.parseDelimited("a\tb\n1\t2\n", "\t"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});
