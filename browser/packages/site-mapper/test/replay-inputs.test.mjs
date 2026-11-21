// Run 2 of a learned site: recorded constants fill themselves in, only what varies is an input,
// and a 400 names what the site flagged beside what the operation declares.
import assert from "node:assert/strict";
import test from "node:test";
import { BadRequest, MissingParams, errorKind, operationInputs } from "../dist/index.js";
import { buildRequest } from "../dist/runtime/request.js";
import { finishRead } from "../dist/runtime/errors.js";
import { bodyConstants } from "../dist/infer/body-constants.js";
import { invalidInputNames } from "../dist/runtime/bad-request.js";

function operation(extra = {}) {
  return {
    id: "searchItems",
    method: "POST",
    origin: "https://shop.test",
    path: "/api/search",
    kind: "rest",
    role: "read",
    params: [
      { name: "q", in: "query", required: true, schema: { type: "string" } },
      { name: "market", in: "query", required: true, schema: { type: "string" }, constant: "us" },
    ],
    requestBody: {
      mime: "application/json",
      schema: {
        type: "object",
        properties: { term: { type: "string" }, channel: { type: "string" } },
      },
      constants: { channel: "web" },
    },
    samples: [],
    dependencies: [],
    responses: {},
    security: [],
    confidence: 1,
    bucket: "high",
    flags: [],
    sampleCount: 3,
    sources: [],
    pageUrls: [],
    ...extra,
  };
}

test("constants fill themselves in and are not inputs", () => {
  const op = operation();
  const { request, missing } = buildRequest(op, { q: "chair", term: "chair" });
  assert.deepEqual(missing, []);
  assert.equal(new URL(request.url).searchParams.get("market"), "us");
  assert.deepEqual(JSON.parse(request.body), { channel: "web", term: "chair" });
  assert.deepEqual(operationInputs(op), ["q", "term"]);
});

test("a caller's value beats a recorded body constant", () => {
  const { request } = buildRequest(operation(), { q: "x", channel: "app" });
  assert.equal(JSON.parse(request.body).channel, "app");
});

test("body constants are the fields that never changed, minus secrets", () => {
  const constants = bodyConstants([
    { channel: "web", term: "a", csrf: "abc", version: 2, session: "s" },
    { channel: "web", term: "b", csrf: "abc", version: 2, session: "s" },
  ]);
  assert.deepEqual(constants, { channel: "web", version: 2 });
  assert.equal(bodyConstants([{ channel: "web" }]), undefined, "one sample proves nothing");
});

test("a missing input is named with the declared list and how to pass it", () => {
  const op = operation();
  const { missing } = buildRequest(op, {});
  const error = new MissingParams(op, missing);
  assert.match(error.message, /needs: query:q/);
  assert.match(error.message, /Declared inputs: q \(query, required\)/);
  assert.match(error.message, /call\("searchItems", \{ q: … \}\)/);
  assert.deepEqual(error.missing, ["query:q"]);
  assert.equal(errorKind(error), "missing-input");
});

test("a 400 names the inputs the site flagged, what is declared and what was passed", () => {
  const response = {
    status: 400,
    headers: {},
    json: { error: "Bad Request", errors: [{ field: "q", message: "q is required" }] },
  };
  let caught;
  try {
    finishRead("searchItems", response, undefined, {
      operation: operation(),
      params: { term: "x" },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BadRequest);
  assert.deepEqual(caught.invalid, ["q"]);
  assert.match(caught.message, /The site flagged: q\./);
  assert.match(caught.message, /searchItems declares: q \(query, required\)/);
  assert.match(caught.message, /Passed: term\./);
  assert.match(caught.message, /Required inputs missing from this call: q\./);
  assert.equal(errorKind(caught), "missing-input");
});

test("the usual 400 shapes are read for the names they flag", () => {
  const names = (json, text) => invalidInputNames({ status: 400, headers: {}, json, text });
  assert.deepEqual(names({ errors: { email: ["is invalid"], age: ["too low"] } }), [
    "email",
    "age",
  ]);
  assert.deepEqual(
    names({ detail: [{ loc: ["body", "limit"], msg: "value is not a valid integer" }] }),
    ["limit"],
  );
  assert.deepEqual(names({ message: "Missing required parameter: 'page_size'" }), ["page_size"]);
  assert.deepEqual(names(undefined, "Field `sort` is required"), ["sort"]);
  assert.deepEqual(names(undefined, "Bad request"), []);
});

test("a 400 that names nothing says so, and still lists what is declared", () => {
  const response = { status: 400, headers: {}, text: "Bad request" };
  try {
    finishRead("searchItems", response, undefined, { operation: operation(), params: {} });
    assert.fail("a 400 throws");
  } catch (error) {
    assert.match(error.message, /did not name the input it rejected/);
    assert.match(error.message, /declares: q \(query, required\)/);
  }
});

test("other statuses keep their own errors", () => {
  assert.throws(() => finishRead("x", { status: 500, headers: {}, text: "boom" }), /HTTP 500/);
});
