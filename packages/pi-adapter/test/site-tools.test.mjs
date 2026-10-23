import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aeonBridge, inChat, sessionChatId } from "../dist/site-browser.js";
import { createSiteApiTool } from "../dist/site-api-tool.js";
import { createCrawlTool } from "../dist/crawl-tool.js";

async function site(t) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/items") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          page: Number(url.searchParams.get("page") ?? 1),
          items: ["lamp", "desk"],
        }),
      );
      return;
    }
    response.setHeader("content-type", "text/html");
    const next = url.pathname === "/" ? '<a href="/about">About</a>' : "";
    response.end(
      `<html><head><title>Page ${url.pathname}</title></head><body><main><h1>Heading ${url.pathname}</h1><p>${"Some real text for the page. ".repeat(20)}</p>${next}</main></body></html>`,
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), "aeon-site-tools-"));
  const previous = { api: process.env.SITE_TO_API_HOME, crawl: process.env.BROWSER_CRAWL_HOME };
  process.env.SITE_TO_API_HOME = join(dir, "api");
  process.env.BROWSER_CRAWL_HOME = join(dir, "crawl");
  t.after(async () => {
    process.env.SITE_TO_API_HOME = previous.api;
    process.env.BROWSER_CRAWL_HOME = previous.crawl;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const text = (result) => result.content[0].text;

test("browser calls from site tools run in a runtime of their own per chat and session", async () => {
  const calls = [];
  const bridge = aeonBridge(async (chatId, toolCallId, input) => {
    calls.push({ chatId, toolCallId, input });
    return JSON.stringify(
      input.codeCell.code === "fail" ? { error: "BROWSER_OFFLINE" } : { value: 42 },
    );
  });
  const chat = "0d6c3c1e-8f3a-4c8e-9a51-2f7d3e9b1c00";
  assert.equal(await inChat(chat, () => bridge.run("1 + 1", { session: "browser-crawl-1" })), 42);
  assert.equal(calls[0].chatId, sessionChatId(chat, "browser-crawl-1"));
  assert.match(calls[0].chatId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(sessionChatId(chat, "a"), sessionChatId(chat, "b"));
  await assert.rejects(
    inChat(chat, () => bridge.run("fail")),
    { name: "BrowserNotConnected" },
  );
});

test("site_api maps a site from a capture in the workspace, then calls it", async (t) => {
  const origin = await site(t);
  const workspace = await home(t);
  const har = {
    log: {
      version: "1.2",
      entries: [1, 2].map((page) => ({
        startedDateTime: new Date().toISOString(),
        request: {
          method: "GET",
          url: `${origin}/api/items?page=${page}`,
          headers: [{ name: "accept", value: "application/json" }],
          queryString: [{ name: "page", value: String(page) }],
        },
        response: {
          status: 200,
          headers: [{ name: "content-type", value: "application/json" }],
          content: {
            mimeType: "application/json",
            text: JSON.stringify({ page, items: ["lamp"] }),
          },
        },
        _resourceType: "fetch",
      })),
    },
  };
  await writeFile(join(workspace, "shop.har"), JSON.stringify(har));
  const tool = createSiteApiTool("chat", workspace);
  const learned = JSON.parse(
    text(await tool.execute("1", { action: "import", site: origin, files: ["shop.har"] })),
  );
  assert.ok(learned.operations.length >= 1, "learn lists the operations right away");
  assert.match(learned.howToCall, /Pass params flat/);
  const sites = JSON.parse(text(await tool.execute("2", { action: "sites" })));
  assert.equal(sites.sites.length, 1);
  const listed = JSON.parse(text(await tool.execute("3", { action: "operations", site: origin })));
  const operation = listed.operations.find((op) => op.path === "/api/items");
  assert.ok(operation, JSON.stringify(listed));
  const result = await tool.execute("4", {
    action: "call",
    site: origin,
    operation: operation.id,
    params: { page: 3 },
    transport: "direct",
  });
  assert.equal(JSON.parse(text(result)).page, 3);
  const missing = await tool.execute("5", { action: "operations", site: "nowhere.example" });
  assert.equal(missing.isError, true);
});

test("crawl scrapes a page and crawls a site into the workspace", async (t) => {
  const origin = await site(t);
  const workspace = await home(t);
  const tool = createCrawlTool("chat", workspace);
  const page = JSON.parse(
    text(await tool.execute("1", { action: "scrape", url: `${origin}/`, render: "static" })),
  );
  assert.match(page.markdown, /# Heading \//);
  const crawled = JSON.parse(
    text(
      await tool.execute("2", { action: "crawl", url: `${origin}/`, limit: 5, render: "static" }),
    ),
  );
  assert.equal(crawled.pages, 2);
  const files = await readdir(join(workspace, crawled.savedIn));
  assert.ok(files.includes("index.json"));
});
