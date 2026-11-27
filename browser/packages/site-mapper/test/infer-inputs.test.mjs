import assert from "node:assert/strict";
import test from "node:test";
import { buildSiteModel } from "../dist/index.js";
import { buildRequest } from "../dist/runtime/request.js";
import { exchange } from "./shape-exchanges.mjs";

const O = "https://wiki.example";
const op = (model, path) => model.operations.find((o) => o.path === path);

test("query plumbing is hidden; other constants are optional inputs with defaults", async () => {
  const exchanges = ["graph", "tree"].map((q) =>
    exchange(`${O}/w/api.php?action=query&format=json&formatversion=2&prop=info&srsearch=${q}`, {
      json: { query: { search: [{ title: q }] } },
    }),
  );
  const { model } = await buildSiteModel(exchanges, { site: "wiki.example" });
  const params = Object.fromEntries(op(model, "/w/api.php").params.map((p) => [p.name, p]));
  assert.equal(params.format.constant, "json");
  assert.equal(params.formatversion.constant, "2");
  assert.equal(params.prop.constant, undefined);
  assert.equal(params.prop.default, "info");
  assert.equal(params.prop.required, false);
  const { request } = buildRequest(op(model, "/w/api.php"), { srsearch: "x" });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("prop"), "info");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(
    buildRequest(op(model, "/w/api.php"), { srsearch: "x", prop: "links" }).request.url.includes(
      "prop=links",
    ),
    true,
  );
});

test("body constants: plumbing hidden, the rest defaults the caller may change", async () => {
  const exchanges = ["n1", "n2"].map((text) =>
    exchange(`${O}/notes`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      requestBody: new URLSearchParams({ _action: "create", text, _: "1" }).toString(),
      json: { created: text },
    }),
  );
  const { model } = await buildSiteModel(exchanges, { site: "wiki.example" });
  const notes = op(model, "/notes");
  assert.deepEqual(notes.requestBody.defaults, { _action: "create" });
  assert.deepEqual(notes.requestBody.constants, { _: 1 });
  const body = new URLSearchParams(buildRequest(notes, { text: "n3" }).request.body);
  assert.equal(body.get("_action"), "create");
  assert.equal(
    new URLSearchParams(buildRequest(notes, { text: "n3", _action: "delete" }).request.body).get(
      "_action",
    ),
    "delete",
  );
});

test("enums need 20 samples and at most 6 values, never for search words", async () => {
  const sorts = ["new", "top", "hot"];
  const exchanges = Array.from({ length: 24 }, (_, i) =>
    exchange(`${O}/api/items?q=${["lamp", "desk"][i % 2]}&sort=${sorts[i % 3]}&n=${i}`, {
      json: { items: [{ id: i }] },
    }),
  );
  const few = exchanges.slice(0, 6);
  const { model } = await buildSiteModel(exchanges, { site: "wiki.example" });
  const params = Object.fromEntries(op(model, "/api/items").params.map((p) => [p.name, p]));
  assert.deepEqual(params.sort.schema.enum, ["hot", "new", "top"]);
  assert.equal(params.q.schema.enum, undefined);
  assert.deepEqual(params.q.examples, ["lamp", "desk"]);
  const small = (await buildSiteModel(few, { site: "wiki.example" })).model;
  const sort = op(small, "/api/items").params.find((p) => p.name === "sort");
  assert.equal(sort.schema.enum, undefined);
});

test("multipart bodies give text fields and binary file fields", async () => {
  const boundary = "----b1";
  const exchanges = ["one.txt", "two.txt"].map((name) =>
    exchange(`${O}/upload`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      requestBody:
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${name}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\nhi\r\n--${boundary}--\r\n`,
      json: { ok: true, bytes: 10 },
    }),
  );
  const { model } = await buildSiteModel(exchanges, { site: "wiki.example" });
  const props = op(model, "/upload").requestBody.schema.properties;
  assert.equal(props.title.type, "string");
  assert.deepEqual(props.file, { type: "string", format: "binary" });
});

test("NDJSON answers are arrays; GraphQL variables are always an object", async () => {
  const hash = "a".repeat(64);
  const exchanges = [
    exchange(`${O}/api/stream?q=a`, { body: '{"i":0}\n{"i":1}\n', mime: "application/x-ndjson" }),
    exchange(`${O}/api/stream?q=b`, { body: '{"i":0}\n', mime: "application/x-ndjson" }),
    ...["paris", "rome"].map((t) =>
      exchange(
        `${O}/gql/Suggest/${hash}?operationName=Suggest&variables=${encodeURIComponent(JSON.stringify({ query: t }))}&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }))}`,
        { json: { data: { s: [{ name: t }] } } },
      ),
    ),
  ];
  const { model } = await buildSiteModel(exchanges, { site: "wiki.example" });
  const stream = op(model, "/api/stream");
  assert.equal(stream.responses["200"].schema.type, "array");
  const gql = model.operations.find((o) => o.kind === "graphql");
  const variables = gql.params.find((p) => p.name === "variables");
  assert.equal(variables.schema.type, "object");
  assert.ok(variables.schema.properties.query);
});

test("auth provenance tags become scheme sources; no value is stored", async () => {
  const exchanges = [
    exchange(`${O}/api/token`, { json: { token: "tok-live-1" } }),
    exchange(`${O}/api/me`, {
      headers: { authorization: "Bearer tok-live-1", "x-csrf-token": "C456" },
      json: { user: "alice" },
      provenance: { authorization: `response:${O}/api/token#/token`, "x-csrf-token": "meta:csrf" },
    }),
  ];
  const { model } = await buildSiteModel(exchanges, { site: "wiki.example" });
  const bearer = model.security.find((s) => s.type === "bearer");
  assert.deepEqual(bearer.source, { kind: "response", operationId: "token", pointer: "/token" });
  const csrf = model.security.find((s) => s.type === "csrf");
  assert.deepEqual(csrf.source, { kind: "meta", name: "csrf" });
});
