import assert from "node:assert/strict";
import test from "node:test";
import { paceLimited, resetPace, setPaceClock, setPaceJitter, takePace } from "../dist/pace.js";
import { Challenged, SiteClient } from "../dist/runtime/site-mapper.js";

let now = 0;
const waits = [];

setPaceJitter(() => 1);
setPaceClock({
  now: () => now,
  wait: async (ms) => {
    waits.push(ms);
    now += ms;
  },
});

function operation(id, role, method, path) {
  return {
    id,
    method,
    origin: "https://wall.test",
    path,
    kind: "rest",
    params: [],
    responses: {},
    role,
    security: [],
    dependencies: [],
    confidence: 1,
    bucket: "high",
    flags: [],
    sampleCount: 0,
    sources: [],
    pageUrls: [],
    samples: [],
  };
}

function model(site, pages = []) {
  return {
    version: 1,
    site,
    title: site,
    generatedAt: "2026-11-11T00:00:00.000Z",
    origins: [`https://${site}`],
    security: [],
    operations: [
      operation("save", "action", "POST", "/save"),
      operation("load", "read", "GET", "/load"),
    ],
    pages,
    channels: [],
    components: {},
    noise: [],
    stats: { exchanges: 0, kept: 0, captures: [] },
  };
}

function client(site, send, transport = "page", pages = []) {
  const reply = async () => send();
  return new SiteClient(model(site, pages), {
    transport,
    transports: {
      page: { name: "page", send: reply },
      direct: { name: "direct", send: reply },
    },
  });
}

async function nextWait(site) {
  waits.length = 0;
  await takePace(site);
  await takePace(site);
  return waits.at(-1);
}

test("a challenged write halves the pace", async () => {
  resetPace();
  now = 0;
  waits.length = 0;
  const site = "write.wall";
  const api = client(site, async () => ({
    status: 403,
    headers: { "cf-mitigated": "challenge" },
    text: "",
  }));
  const response = await api.write("save", {});
  assert.equal(response.status, 403);
  assert.equal(paceLimited(site), true);
  assert.equal(await nextWait(site), 2000);
});

test("a direct page fetch that is challenged or 429 halves the pace", async () => {
  resetPace();
  now = 0;
  const site = "fetch.wall";
  const page = {
    id: "home",
    origin: "https://wall.test",
    path: "/",
    params: [],
    embedded: ["jsonld"],
    sampleCount: 0,
    samples: [],
  };
  const api = client(site, async () => ({ status: 429, headers: {}, text: "" }), "direct", [page]);
  await api.fetchPage("home");
  assert.equal(paceLimited(site), true);
  assert.equal(await nextWait(site), 2000);
});

test("a challenged read throws and halves the pace", async () => {
  resetPace();
  now = 0;
  const site = "call.wall";
  const api = client(
    site,
    async () => ({ status: 403, headers: { "cf-mitigated": "challenge" }, text: "just a moment" }),
    "direct",
  );
  await assert.rejects(api.call("load"), Challenged);
  assert.equal(paceLimited(site), true);
});

test("a normal write does not halve the pace", async () => {
  resetPace();
  now = 0;
  const site = "ok.wall";
  const api = client(site, async () => ({ status: 200, headers: {}, json: { ok: true } }));
  await api.write("save", {});
  assert.equal(paceLimited(site), false);
});
