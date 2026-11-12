import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

const app = fileURLToPath(new URL("../", import.meta.url));
const base = "chrome-extension://abc/";

async function load() {
  const directory = await mkdtemp(join(tmpdir(), "aeon-orb-pages-"));
  const outfile = join(directory, "bundle.mjs");
  await build({
    entryPoints: [join(app, "src/orb/orb-aeon-pages.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

test("the cursor goes on web pages and Aeon's own tabs, never on its frames or chrome://", async () => {
  const pages = await load();
  assert.equal(pages.isCursorPage("https://example.com/", base), true);
  assert.equal(pages.isCursorPage(base + "home.html", base), true);
  assert.equal(pages.isCursorPage(base + "chat.html?chatId=1", base), true);
  assert.equal(pages.isCursorPage(base + "orb.html?tabId=1", base), false);
  assert.equal(pages.isCursorPage(base + "sidepanel.html", base), false);
  assert.equal(pages.isCursorPage("chrome-extension://other/home.html", base), false);
  assert.equal(pages.isCursorPage("chrome://settings", base), false);
});

test("a chat tab's cursor box follows that chat; the side panel's framed chat does not", async () => {
  const pages = await load();
  assert.equal(pages.pageChatId(base + "chat.html?chatId=c1"), "c1");
  assert.equal(pages.pageChatId(base + "chat.html?chatId=c1&host=panel"), undefined);
  assert.equal(pages.pageChatId(base + "home.html"), undefined);
});

test("every Aeon tab page loads the cursor's content script itself", async () => {
  for (const page of ["home", "chat", "viewer", "site-scripts"]) {
    const html = await readFile(join(app, page + ".html"), "utf8");
    assert.match(html, /<script src="orb-content\.js"><\/script>/, page);
  }
});
