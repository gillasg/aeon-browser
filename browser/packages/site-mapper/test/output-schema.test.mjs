import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  catalogToolsForSite,
  inferOutputSchema,
  operationOutputSchema,
  outputSchemaFromJsonSchema,
  structuredOutput,
} from "../dist/index.js";
import { readOpsFile, writeOpsFile } from "../dist/site-ops-file.js";

test("one object sample: types, and no key is required", () => {
  const schema = inferOutputSchema([{ id: 1, name: "a", price: 2.5, ok: true, gone: null }]);
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      price: { type: "number" },
      ok: { type: "boolean" },
      gone: { type: "null" },
    },
  });
});

test("several samples: union of keys, none required", () => {
  const schema = inferOutputSchema([{ id: 1, a: "x" }, { id: 2.5, b: 1 }, null]);
  assert.equal(schema.type, "object", "null answers do not change the object root");
  assert.deepEqual(Object.keys(schema.properties), ["id", "a", "b"]);
  assert.equal(schema.required, undefined);
  assert.equal(schema.properties.id.type, "number", "integer and number merge to number");
});

test("nested objects and arrays", () => {
  const schema = inferOutputSchema([
    { user: { tags: ["a"], posts: [{ t: "x" }, { t: "y", n: 1 }] } },
  ]);
  const user = schema.properties.user;
  assert.equal(user.type, "object");
  assert.deepEqual(user.properties.tags, { type: "array", items: { type: "string" } });
  assert.deepEqual(user.properties.posts.items, { type: "object" }, "level 4 is a leaf");
  const posts = inferOutputSchema([{ posts: [{ t: "x" }, { t: "y", n: 1 }] }]).properties.posts;
  assert.equal(posts.items.required, undefined);
  assert.deepEqual(Object.keys(posts.items.properties), ["t", "n"]);
});

test("a top-level array is wrapped so the root is an object", () => {
  const schema = inferOutputSchema([[{ id: 1 }], [{ id: 2 }]]);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["items"]);
  assert.equal(schema.properties.items.type, "array");
  assert.deepEqual(structuredOutput([{ id: 1 }], schema), { items: [{ id: 1 }] });
  assert.deepEqual(inferOutputSchema(["s"]).properties.value, { type: "string" });
  assert.deepEqual(structuredOutput("s", inferOutputSchema(["s"])), { value: "s" });
  assert.equal(inferOutputSchema([]), undefined);
});

test("depth and property counts stay bounded", () => {
  const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
  const schema = inferOutputSchema([deep]);
  assert.deepEqual(schema.properties.a.properties.b.properties.c, { type: "object" });
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(inferOutputSchema([wide]).properties).length, 30);
  assert.equal(Object.keys(inferOutputSchema([wide], { maxProperties: 5 }).properties).length, 5);
  assert.ok(JSON.stringify(inferOutputSchema([{ s: "a very specific sample value" }])).length < 80);
});

test("a recorded response schema becomes a trimmed, object-rooted outputSchema", () => {
  const op = {
    id: "listTags",
    method: "GET",
    path: "/api/tags",
    responses: {
      200: {
        mime: "application/json",
        schema: {
          type: "array",
          items: { type: "object", properties: { tag: { type: "string", examples: ["x"] } } },
        },
      },
    },
  };
  const schema = operationOutputSchema(op);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties.items.items.properties.tag, { type: "string" });
  assert.equal(outputSchemaFromJsonSchema(undefined), undefined);
  const saved = { type: "object", properties: { x: { type: "string" } } };
  assert.equal(operationOutputSchema({ ...op, outputSchema: saved }), saved);
  const model = {
    site: "s.example",
    operations: [
      { ...op, params: [], role: "read", security: [], kind: "rest", origin: "https://s.example" },
    ],
  };
  const [tool] = catalogToolsForSite("s.example", model, [], new Set());
  assert.equal(tool.outputSchema.type, "object");
});

test("api.json round-trips outputSchema and still reads files without it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "output-schema-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const outputSchema = inferOutputSchema([{ id: 1 }]);
  await writeOpsFile("s.example", [
    { id: "get", kind: "http", source: "api", outputSchema },
    { id: "old", kind: "http", source: "api" },
  ]);
  const file = await readOpsFile("s.example");
  assert.deepEqual(file.ops[0].outputSchema, outputSchema);
  assert.equal(file.ops[1].outputSchema, undefined);
});

test("saved and recorded schemas keep only the root wrapper's required", () => {
  const saved = operationOutputSchema({
    outputSchema: {
      type: "object",
      properties: {
        query: { type: "object", properties: { normalized: {} }, required: ["normalized"] },
      },
      required: ["query"],
    },
  });
  assert.equal(saved.required, undefined);
  assert.equal(saved.properties.query.required, undefined);
  const recorded = outputSchemaFromJsonSchema({
    type: "array",
    items: { type: "object", properties: { id: {} }, required: ["id"] },
  });
  assert.deepEqual(recorded.required, ["items"]);
  assert.equal(recorded.properties.items.items.required, undefined);
});
