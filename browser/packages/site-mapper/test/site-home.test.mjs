import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { siteDir, siteHome, siteStartUrl } from "../dist/index.js";

test("local and private-network sites start on http, public sites on https", () => {
  assert.equal(siteHome("localhost:3000"), "http://localhost:3000/");
  assert.equal(siteHome("127.0.0.1:5173"), "http://127.0.0.1:5173/");
  assert.equal(siteHome("192.168.1.1"), "http://192.168.1.1/");
  assert.equal(siteHome("10.0.0.7:8080"), "http://10.0.0.7:8080/");
  assert.equal(siteHome("printer.local"), "http://printer.local/");
  assert.equal(siteHome("shop.example"), "https://shop.example/");
  assert.equal(siteHome("172.40.1.1"), "https://172.40.1.1/");
  assert.equal(siteHome("http://shop.example/x"), "http://shop.example/x");
});

test("a bare site starts on the origin it was mapped from", async (t) => {
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = await mkdtemp(join(tmpdir(), "site-home-"));
  t.after(() => {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
  });
  await mkdir(siteDir("10.1.2.3"), { recursive: true });
  await writeFile(
    join(siteDir("10.1.2.3"), "model.json"),
    JSON.stringify({ site: "10.1.2.3", origins: ["http://10.1.2.3:9000"], operations: [] }),
  );
  assert.equal(await siteStartUrl("10.1.2.3"), "http://10.1.2.3:9000/");
  assert.equal(await siteStartUrl("unmapped.example"), "https://unmapped.example/");
  assert.equal(await siteStartUrl("https://given.example/start"), "https://given.example/start");
});

test("a bare site with no recorded origin starts where its saved abilities call", async (t) => {
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = await mkdtemp(join(tmpdir(), "site-home-"));
  t.after(() => {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
  });
  const site = "127.0.0.1";
  await mkdir(join(siteDir(site), "abilities"), { recursive: true });
  await writeFile(
    join(siteDir(site), "model.json"),
    JSON.stringify({ site, origins: [], operations: [] }),
  );
  const code = 'const r = await browser.fetch("http://127.0.0.1:8790/h11/books"); return r;';
  await writeFile(
    join(siteDir(site), "abilities", "books.json"),
    JSON.stringify({ site, name: "books", ways: [{ kind: "script", code }] }),
  );
  assert.equal(await siteStartUrl(site), "http://127.0.0.1:8790/");
});
