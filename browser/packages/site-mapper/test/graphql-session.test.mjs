import assert from "node:assert/strict";
import test from "node:test";
import { buildOperation, groupExchanges } from "../dist/infer/operations.js";
import { buildRequest } from "../dist/runtime/request.js";
import { cookieXsrfHeaders, withoutSessionValues } from "../dist/session-headers.js";
import { operationInputs } from "../dist/params.js";

function gql(body, headers = {}) {
  return {
    category: "api",
    exchange: {
      url: "https://app.example/api/graphql",
      method: "POST",
      status: 200,
      source: "rec",
      requestHeaders: { "content-type": "application/json", ...headers },
      requestBody: JSON.stringify(body),
      responseHeaders: { "content-type": "application/json" },
      responseMime: "application/json",
      responseBody: JSON.stringify({ data: { ok: true } }),
    },
  };
}

const SEARCH =
  "query SearchUsers($term: String!, $first: Int) { users(term: $term, first: $first) { id } }";
const VIEWER = "{ viewer { id name } }";

function operations(items) {
  return groupExchanges(items).groups.map(buildOperation);
}

test("GraphQL calls split by operationName, root field and persisted hash, not one post_graphql", () => {
  const ops = operations([
    gql({ query: SEARCH, operationName: "SearchUsers", variables: { term: "ada", first: 10 } }),
    gql({ query: SEARCH, operationName: "SearchUsers", variables: { term: "bob", first: 10 } }),
    gql({ query: VIEWER }),
    gql({
      operationName: "Timeline",
      variables: { count: 20 },
      extensions: { persistedQuery: { version: 1, sha256Hash: "f00d" } },
    }),
    gql({ query: "mutation Like($id: ID!) { like(id: $id) { ok } }", variables: { id: "1" } }),
  ]);
  const ids = ops.map((op) => op.id).sort();
  assert.deepEqual(ids, ["getViewer", "like", "searchUsers", "timeline"]);
  assert.equal(ops.find((op) => op.id === "like").role, "action");
  assert.equal(ops.find((op) => op.id === "getViewer").graphql.field, "viewer");
  assert.equal(ops.find((op) => op.id === "getViewer").graphql.operationName, undefined);
});

test("variables become inputs, invariant ones constants; replay fills both and keeps the document", () => {
  const [op] = operations([
    gql({ query: SEARCH, operationName: "SearchUsers", variables: { term: "ada", first: 10 } }),
    gql({ query: SEARCH, operationName: "SearchUsers", variables: { term: "bob", first: 10 } }),
  ]);
  const term = op.graphql.variables.find((item) => item.name === "term");
  const first = op.graphql.variables.find((item) => item.name === "first");
  assert.equal(term.constant, undefined);
  assert.equal(term.required, true);
  assert.equal(first.constant, 10);
  assert.ok(operationInputs(op).includes("term"));
  assert.ok(!operationInputs(op).includes("first"));
  const { request } = buildRequest(op, { term: "cy" });
  const body = JSON.parse(request.body);
  assert.equal(body.query, SEARCH);
  assert.equal(body.operationName, "SearchUsers");
  assert.deepEqual(body.variables, { first: 10, term: "cy" });
  // An explicit variables object still works and wins over constants.
  const explicit = JSON.parse(
    buildRequest(op, { variables: { term: "x", first: 2 } }).request.body,
  );
  assert.deepEqual(explicit.variables, { first: 2, term: "x" });
});

test("persisted-query extensions stay as a constant and replay", () => {
  const call = (count) =>
    gql({
      operationName: "Timeline",
      variables: { count },
      extensions: { persistedQuery: { version: 1, sha256Hash: "f00d" } },
    });
  const [op] = operations([call(20), call(40)]);
  assert.deepEqual(op.graphql.extensions, { persistedQuery: { version: 1, sha256Hash: "f00d" } });
  const body = JSON.parse(buildRequest(op, { count: 5 }).request.body);
  assert.deepEqual(body.extensions, { persistedQuery: { version: 1, sha256Hash: "f00d" } });
  assert.deepEqual(body.variables, { count: 5 });
});

test("GET GraphQL replays its envelope in the query string", () => {
  const url = (term) =>
    `https://app.example/graphql?operationName=Find&query=${encodeURIComponent("query Find($q: String) { find(q: $q) { id } }")}&variables=${encodeURIComponent(JSON.stringify({ q: term }))}`;
  const get = (term) => ({
    category: "api",
    exchange: {
      url: url(term),
      method: "GET",
      status: 200,
      source: "rec",
      requestHeaders: {},
      responseHeaders: { "content-type": "application/json" },
      responseMime: "application/json",
      responseBody: JSON.stringify({ data: { find: [] } }),
    },
  });
  const [op] = operations([get("a"), get("b")]);
  const { request } = buildRequest(op, { q: "zed" });
  const sent = new URL(request.url);
  assert.equal(sent.searchParams.get("operationName"), "Find");
  assert.deepEqual(JSON.parse(sent.searchParams.get("variables")), { q: "zed" });
  assert.equal(request.body, undefined);
});

test("session headers are never kept in the model and are left for the live tab to fill", () => {
  const headers = {
    authorization: "Bearer secret-abc",
    "x-csrf-token": "csrf-123",
    "x-api-key": "key-xyz",
    "x-client-transaction-id": "tid-1",
    "x-app-version": "7",
  };
  const [op] = operations([
    gql({ query: SEARCH, operationName: "SearchUsers", variables: { term: "a" } }, headers),
    gql({ query: SEARCH, operationName: "SearchUsers", variables: { term: "b" } }, headers),
  ]);
  const saved = JSON.stringify(op);
  for (const secret of ["secret-abc", "csrf-123", "key-xyz", "tid-1"])
    assert.equal(saved.includes(secret), false, `${secret} must not be stored`);
  const csrf = op.params.find((param) => param.name === "x-csrf-token");
  assert.equal(csrf.derived, "session");
  assert.equal(csrf.constant, undefined);
  assert.equal(csrf.examples, undefined);
  // A plain app header keeps its constant; session headers are not sent from the recording.
  const { request } = buildRequest(op, { term: "c" });
  assert.equal(request.headers["x-app-version"], "7");
  assert.equal(request.headers["x-csrf-token"], undefined);
  assert.equal(request.headers["x-api-key"], undefined);
});

test("XSRF cookies map to the header the site expects, without overriding one already set", () => {
  const jar = { "XSRF-TOKEN": "x1", csrftoken: "d2", ct0: "t3" };
  const read = (name) => jar[name];
  assert.deepEqual(cookieXsrfHeaders(read), {
    "x-xsrf-token": "x1",
    "x-csrftoken": "d2",
    "x-csrf-token": "t3",
  });
  assert.deepEqual(cookieXsrfHeaders(read, { "X-XSRF-TOKEN": "live" }), {
    "x-csrftoken": "d2",
    "x-csrf-token": "t3",
  });
  assert.deepEqual(withoutSessionValues({ authorization: "Bearer z", accept: "*/*" }), {
    authorization: "[session]",
    accept: "*/*",
  });
});
