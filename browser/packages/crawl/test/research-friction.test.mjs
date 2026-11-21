import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AutoFetcher,
  BrowserFetcher,
  emptyShell,
  findList,
  needsBrowser,
  rejectReason,
  scrape,
  shouldRenderShell,
} from "../dist/index.js";
import { startCrawlSite } from "./fixture-site.mjs";
import { fakeAuto, tempHome } from "./helpers.mjs";

test("find says why nothing matched and lists the pages it opened", async () => {
  const report = await findList("seed startups", {
    columns: { name: "name" },
    search: async () => [
      { url: "https://example.com/empty", page: { markdown: "   " } },
      { url: "https://example.com/missing" },
      {
        url: "https://example.com/article",
        page: { markdown: "A long article about the weather and nothing else." },
      },
    ],
    model: {
      async complete() {
        return {
          content: [
            { type: "toolCall", name: "result", arguments: { data: { matches: false, rows: [] } } },
          ],
        };
      },
    },
  });
  assert.deepEqual(report.rows, []);
  assert.equal(report.why, "no page matched the criteria");
  assert.deepEqual(report.opened, [
    "https://example.com/empty",
    "https://example.com/missing",
    "https://example.com/article",
  ]);
  assert.deepEqual(
    report.rejected.map((page) => page.reason),
    ["no page text", "could not read the page", "did not match the criteria"],
  );
  assert.equal(
    rejectReason("Acme", { matches: true, rows: [{ name: "Acme" }] }, 0),
    "matched but added no new row",
  );
});

test("a nested app shell is rendered in the named browser, and static render is not", async (t) => {
  await tempHome(t);
  const shell = `<!doctype html><html><body><div id="__next"><div></div></div><p>${"Loading jobs ".repeat(30)}</p><script src="/app.js"></script></body></html>`;
  assert.equal(emptyShell(shell), true);
  assert.equal(
    needsBrowser({ status: 200, contentType: "text/html", headers: {}, body: Buffer.from(shell) }),
    "empty app shell",
  );
  const calls = [];
  const browser = {
    name: "browser",
    async fetch(url, options) {
      calls.push(options.browser);
      const html =
        "<html><body><h1>Jobs</h1><ul><li>Engineer</li><li>Designer</li></ul></body></html>";
      return {
        url,
        finalUrl: url,
        status: 200,
        headers: {},
        contentType: "text/html",
        body: Buffer.from(html),
        html,
        fetchedBy: "browser",
      };
    },
    async close() {},
  };
  const stat = {
    name: "static",
    async fetch(url) {
      return {
        url,
        finalUrl: url,
        status: 200,
        headers: {},
        contentType: "text/html",
        body: Buffer.from(shell),
        fetchedBy: "static",
      };
    },
  };
  const fetcher = new AutoFetcher({ fetchers: { static: stat, browser } });
  const page = await scrape(
    "https://jobs.example/list",
    { formats: ["markdown"], browser: "recording" },
    { fetcher },
  );
  assert.equal(page.fetchedBy, "browser");
  assert.match(page.markdown, /Engineer/);
  assert.deepEqual(calls, ["recording"]);
  calls.length = 0;
  const held = await scrape(
    "https://jobs.example/list",
    { formats: ["markdown"], render: "static" },
    { fetcher },
  );
  assert.equal(held.fetchedBy, "static");
  assert.deepEqual(calls, []);
  assert.equal(shouldRenderShell("", shell, "static", "static"), false);
  assert.equal(shouldRenderShell("", "<script src=app.js></script>", "static", "auto"), true);
});

test("a query keeps the full page in markdown and the slice in fitMarkdown", async (t) => {
  await tempHome(t);
  const site = await startCrawlSite();
  t.after(() => site.close());
  const { fetcher } = fakeAuto();
  const page = await scrape(
    `${site.origin}/blog/post-2`,
    { formats: ["fitMarkdown", "metadata"], query: "Post" },
    { fetcher },
  );
  assert.match(page.markdown, /Post 2/);
  assert.ok(page.markdown.length >= (page.fitMarkdown ?? "").length);
  assert.ok(page.fitMarkdown === undefined || page.fitMarkdown.length <= page.markdown.length);
});

test("browser fetch passes the named browser through to the bridge", async () => {
  const seen = [];
  const bridge = {
    async run(_code, options) {
      seen.push(options);
      return {
        finalUrl: "https://example.com/",
        status: 200,
        contentType: "text/html",
        html: "<p>Hi</p>",
        actionShots: [],
      };
    },
    async status() {
      return { browsers: 2 };
    },
    close() {},
  };
  const dir = await mkdtemp(join(tmpdir(), "crawl-browser-"));
  const fetcher = new BrowserFetcher(1, async () => bridge, "browser-crawl");
  await fetcher.fetch("https://example.com/", { browser: "recording" });
  assert.equal(seen[0].browser, "recording");
  await fetcher.close();
  assert.equal(seen.at(-1).browser, "recording");
  assert.equal(dir.length > 0, true);
});
