import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { observations } from "../dist/emit/observations.js";
import { toOpenApi } from "../dist/emit/openapi.js";
import { emitFromHar, modelFromCapture } from "../dist/har-emit.js";
import { templatePaths } from "../dist/infer/templates.js";
import { periodicEndpoints, withoutPeriodicSteps } from "../dist/periodic.js";
import { tempHome } from "./helpers.mjs";

const run = promisify(execFile);

test("1–2 digit segments at the root or after api are versions, not ids", () => {
  const paths = templatePaths([
    { url: "https://a.test/api/2/users/8812" },
    { url: "https://a.test/1/indexes/products" },
    { url: "https://a.test/items/12/reviews" },
  ]).map((p) => p.template);
  assert.equal(paths[0], "/api/2/users/{userId}");
  assert.equal(paths[1], "/1/indexes/products");
  assert.equal(paths[2], "/items/{itemId}/reviews");
});

test("parameters are named after the resource segment before them", () => {
  const repos = templatePaths(
    ["react-app", "vue-app", "svelte-kit"].map((repo) => ({ url: `https://a.test/repos/${repo}` })),
  );
  assert.equal(repos[0].template, "/repos/{repo}");
  assert.deepEqual(repos[0].params[0], { name: "repo", value: "react-app", kind: "slug" });
  const users = templatePaths([{ url: "https://a.test/users/5521" }]);
  assert.equal(users[0].template, "/users/{userId}");
  const slugs = templatePaths(
    ["blue-shirt", "red-hat", "green-sock"].map((s) => ({ url: `https://a.test/products/${s}` })),
  );
  assert.equal(slugs[0].template, "/products/{product}");
});

function exchange(id, url, startedAt, extra = {}) {
  return {
    id,
    source: "t",
    startedAt,
    method: "GET",
    url,
    requestHeaders: {},
    status: 200,
    responseHeaders: {},
    ...extra,
  };
}

test("calls on a fixed clock lose their page step; user-driven calls keep it", () => {
  const items = [];
  for (let i = 0; i < 6; i++)
    items.push({
      exchange: exchange(
        `h${i}`,
        "https://a.test/api/heartbeat",
        1000 + i * 30_000 + (i % 2) * 200,
        { step: 'click "Buy"' },
      ),
    });
  items.push({
    exchange: exchange("c1", "https://a.test/api/cart", 5_000, { step: 'click "Buy"' }),
  });
  items.push({
    exchange: exchange("c2", "https://a.test/api/cart", 9_000, { step: 'click "Buy"' }),
  });
  for (const [i, at] of [0, 1_000, 9_000, 9_500, 30_000].entries())
    items.push({ exchange: exchange(`s${i}`, "https://a.test/api/search", at, { step: "type" }) });
  assert.deepEqual(
    [...periodicEndpoints(items.map((item) => item.exchange))],
    ["GET https://a.test/api/heartbeat"],
  );
  const cleaned = withoutPeriodicSteps(items);
  assert.ok(
    cleaned
      .filter((item) => item.exchange.url.endsWith("heartbeat"))
      .every((item) => !item.exchange.step),
  );
  assert.ok(
    cleaned
      .filter((item) => !item.exchange.url.endsWith("heartbeat"))
      .every((item) => item.exchange.step),
  );
  assert.equal(items[0].exchange.step, 'click "Buy"', "inputs are not mutated");
});

test("x-graft-observations reports per-field presence over the samples", () => {
  const samples = [
    { responseBody: JSON.stringify({ id: 1, name: "a", tags: [{ k: 1 }] }) },
    { responseBody: JSON.stringify({ id: 2, tags: [] }) },
    { responseBody: "not json" },
  ];
  const result = observations(samples);
  assert.equal(result.sampleCount, 2);
  assert.deepEqual(result.fields["/id"], { presentCount: 2, presenceRatio: 1 });
  assert.deepEqual(result.fields["/name"], { presentCount: 1, presenceRatio: 0.5 });
  assert.equal(result.fields["/tags/*/k"].presentCount, 1);
});

function har(entries) {
  return JSON.stringify({ log: { version: "1.2", creator: { name: "t", version: "1" }, entries } });
}

function harEntry(url, body, method = "GET", started = "2026-01-01T00:00:00.000Z") {
  return {
    startedDateTime: started,
    time: 1,
    request: {
      method,
      url,
      httpVersion: "HTTP/1.1",
      headers: [{ name: "accept", value: "application/json" }],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      redirectURL: "",
      headersSize: -1,
      bodySize: body.length,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { size: body.length, mimeType: "application/json", text: body },
    },
    cache: {},
    timings: { send: 0, wait: 1, receive: 0 },
  };
}

async function writeHar(dir) {
  const path = join(dir, "shop.har");
  await writeFile(
    path,
    har([
      harEntry(
        "https://shop.test/api/products/1001",
        JSON.stringify({ id: 1001, name: "Lamp", price: 12 }),
      ),
      harEntry("https://shop.test/api/products/1002", JSON.stringify({ id: 1002, name: "Desk" })),
      harEntry(
        "https://shop.test/api/products/1003",
        JSON.stringify({ id: 1003, name: "Chair", price: 30 }),
      ),
      harEntry("https://shop.test/api/search?q=lamp", JSON.stringify({ results: [{ id: 1001 }] })),
    ]),
  );
  return path;
}

test("OpenAPI exports carry x-graft-observations from the capture", async (t) => {
  const dir = await tempHome(t);
  const model = await modelFromCapture(await writeHar(dir));
  const doc = toOpenApi(model);
  const op = Object.values(doc.paths["/api/products/{productId}"])[0];
  assert.equal(op["x-graft-observations"].sampleCount, 3);
  assert.equal(op["x-graft-observations"].fields["/price"].presentCount, 2);
});

test("graft re har --emit client writes a zero-dependency typed client that works", async (t) => {
  const dir = await tempHome(t);
  const file = await writeHar(dir);
  const out = join(dir, "client");
  const result = await emitFromHar(file, { emit: "client", out });
  const source = await readFile(join(out, "client.ts"), "utf8");
  assert.doesNotMatch(source, /^import /m, "no imports: zero dependencies");
  assert.match(source, /export function createClient/);
  assert.match(source, /export type \w+Response/);
  assert.ok(result.written.some((path) => path.endsWith("openapi.json")));
  const mock = await emitFromHar(file, { emit: "mock" });
  t.after(() => mock.server.close());
  const js = join(dir, "client.mts");
  await writeFile(js, source);
  const script = `import { createClient } from ${JSON.stringify(pathToFileURL(js).href)};
    const client = createClient({ baseUrl: ${JSON.stringify(mock.server.url)} });
    const name = Object.keys(client).find((key) => /product/i.test(key) && !/search/i.test(key));
    console.log(JSON.stringify(await client[name]({ productId: "1002" })));`;
  const { stdout } = await run(process.execPath, [
    "--experimental-strip-types",
    "--no-warnings",
    "--input-type=module",
    "-e",
    script,
  ]);
  assert.deepEqual(JSON.parse(stdout.trim()), { id: 1002, name: "Desk" });
});

test("graft re har --emit mock replays recorded responses and never forwards", async (t) => {
  const dir = await tempHome(t);
  const result = await emitFromHar(await writeHar(dir), { emit: "mock" });
  t.after(() => result.server.close());
  const one = await fetch(`${result.server.url}/api/products/1003`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).name, "Chair");
  assert.ok(one.headers.get("x-graft-mock"));
  const fallback = await fetch(`${result.server.url}/api/products/9999`);
  assert.equal(fallback.status, 200, "an unseen id answers with a recorded sample");
  const miss = await fetch(`${result.server.url}/api/unknown`);
  assert.equal(miss.status, 404);
});

test("graft re har --emit pack writes a site pack whose OpenAPI has observations", async (t) => {
  const dir = await tempHome(t);
  const out = join(dir, "shop.zip");
  const result = await emitFromHar(await writeHar(dir), { emit: "pack", out });
  assert.equal(result.site, "shop.test");
  assert.ok(existsSync(out));
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(await readFile(out));
  const name = Object.keys(files).find((path) => /openapi\.json$/.test(path));
  assert.ok(name, Object.keys(files).join(","));
  assert.match(strFromU8(files[name]), /x-graft-observations/);
});
