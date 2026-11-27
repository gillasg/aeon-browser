// A crawl is fast and fetches each page once: plain HTTP first, Chrome only for the one page that
// is a JavaScript shell, every URL hit once, the crawl stays under the start folder unless
// `scope: "site"`, and a page whose rel=canonical names a page already kept is dropped.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AutoFetcher, BrowserFetcher, crawl } from "../dist/index.js";
import { browserReady, launchBrowser } from "./browser-harness.mjs";
import { tempHome } from "./helpers.mjs";

const NAV = [
  "/c/",
  "/c/a",
  "/c/b",
  "/c/b?utm_source=x",
  "/c/b#top",
  "/c/spa",
  "/c/list?page=1",
  "/c/canon-alt",
  "/c/dead",
  "/elsewhere",
]
  .map((href) => `<a href="${href}">${href}</a>`)
  .join(" ");

const page = (title, body, head = "") =>
  `<!doctype html><title>${title}</title>${head}<nav>${NAV}</nav><main><h1>${title}</h1>${body}</main>`;

async function startSite(t) {
  const hits = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const key = url.pathname + url.search;
    hits[key] = (hits[key] ?? 0) + 1;
    const send = (html, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const p = url.pathname;
    if (p === "/c/") return send(page("Crawl home", "<p>CRAWLHOME unique text.</p>"));
    if (p === "/c/a") return send(page("Page A", "<p>ALPHA content paragraph.</p>"));
    if (p === "/c/b") return send(page("Page B", "<p>BRAVO content.</p>"));
    if (p === "/c/canon-alt")
      return send(page("Page B", "<p>BRAVO content.</p>", `<link rel=canonical href="/c/b">`));
    if (p === "/c/spa")
      return send(
        `<!doctype html><title>SPA</title><div id="root"></div><script>document.getElementById('root').innerHTML='<h1>SPA ready</h1><p>SPARENDERED text only after JS.</p>'</script>`,
      );
    if (p === "/c/list") {
      const n = Number(url.searchParams.get("page") ?? 1);
      const next = n < 4 ? `<a href="/c/list?page=${n + 1}">Next</a>` : "";
      return send(page(`List ${n}`, `<p>LISTPAGE${n}</p>${next}`));
    }
    if (p === "/elsewhere") return send(page("Elsewhere", "<p>OUTSIDE the start path.</p>"));
    if (p === "/c/dead") return send("<title>Not found</title>missing", 404);
    send("not here", 404);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

/** Renders the shell the way Chrome would, without touching the test server again. */
class ShellBrowser {
  name = "browser";
  calls = [];
  async fetch(url) {
    this.calls.push(url);
    const html = `<title>SPA</title><h1>SPA ready</h1><p>SPARENDERED text only after JS.</p>`;
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
  }
  async close() {}
}

const options = (origin, extra = {}) => ({
  url: `${origin}/c/`,
  source: "links",
  limit: 50,
  maxDepth: 4,
  delayMs: 0,
  autoThrottle: false,
  ...extra,
});

test("static first, each URL once, start-path scope and canonical dedup", async (t) => {
  await tempHome(t);
  const site = await startSite(t);
  const browser = new ShellBrowser();
  const fetcher = new AutoFetcher({ fetchers: { browser } });
  const pages = await crawl(options(site.origin), { fetcher });
  const byPath = Object.fromEntries(
    pages.map((p) => [new URL(p.url).pathname + new URL(p.url).search, p]),
  );

  assert.deepEqual(browser.calls, [`${site.origin}/c/spa`], "only the JS shell went to Chrome");
  assert.equal(byPath["/c/a"].fetchedBy, "static");
  assert.match(byPath["/c/spa"].markdown, /SPARENDERED/);
  for (const [path, count] of Object.entries(site.hits))
    if (path.startsWith("/c/")) assert.equal(count, 1, `${path} was fetched once`);
  assert.equal(site.hits["/elsewhere"], undefined, "stays under /c/ by default");
  assert.ok(!byPath["/c/canon-alt"], "the canonical duplicate is dropped");
  assert.ok(byPath["/c/b"]);
  assert.equal(pages.filter((p) => /BRAVO/.test(p.markdown ?? "")).length, 1);
  assert.ok(byPath["/c/list?page=4"], "pagination is followed");
});

test("scope: site widens the crawl to the whole origin", async (t) => {
  await tempHome(t);
  const site = await startSite(t);
  const fetcher = new AutoFetcher({ fetchers: { browser: new ShellBrowser() } });
  const pages = await crawl(options(site.origin, { scope: "site" }), { fetcher });
  assert.ok(pages.some((p) => p.url.endsWith("/elsewhere")));
});

test(
  "real Chrome: 13 pages in under 8 s, Chrome only for the shell",
  { skip: !process.env.REQUIRE_E2E && !browserReady, timeout: 120_000 },
  async (t) => {
    await launchBrowser(t);
    const site = await startSite(t);
    const fetcher = new AutoFetcher({ fetchers: { browser: new BrowserFetcher(2) } });
    t.after(() => fetcher.close());
    const started = Date.now();
    const pages = await crawl(options(site.origin), { fetcher });
    const ms = Date.now() - started;
    assert.ok(ms <= 8_000, `took ${ms} ms`);
    const spa = pages.find((p) => p.url.endsWith("/c/spa"));
    assert.equal(spa.fetchedBy, "browser");
    assert.match(spa.markdown, /SPARENDERED/);
    assert.ok(pages.filter((p) => p.fetchedBy === "browser").length === 1);
  },
);
