import assert from "node:assert/strict";
import test from "node:test";
import { detectSigning, markSignedParams } from "../dist/infer/signing.js";
import { inferSecurity } from "../dist/infer/auth.js";
import { traceDependencies } from "../dist/infer/trace.js";

let clock = 1_700_000_000_000;

function exchange(url, extra = {}) {
  clock += 1000;
  return {
    id: String(clock),
    source: "test",
    startedAt: clock,
    method: "GET",
    url,
    requestHeaders: {},
    status: 200,
    responseHeaders: {},
    ...extra,
  };
}

function member(url, extra = {}) {
  return { exchange: exchange(url, extra), pathValues: {} };
}

function operation(params, extra = {}) {
  return {
    id: "op",
    origin: "https://example.test",
    method: "GET",
    path: "/",
    params: params.map(([where, name]) => ({ in: where, name, schema: { type: "string" } })),
    dependencies: [],
    security: [],
    ...extra,
  };
}

test("per-call query challenge token is detected, cursor and search are not", () => {
  const members = [
    member(
      "https://www.booking.test/dml/graphql?chal_t=a8f3K29xQpL0zZ71mN&cursor=c1x9Yb7Qw2Er5Ty8&q=paris",
    ),
    member(
      "https://www.booking.test/dml/graphql?chal_t=Z1q7Wm3Rt9Kp0Xb4Lc&cursor=c2x9Yb7Qw2Er5Ty9&q=rome",
    ),
  ];
  const op = operation([
    ["query", "chal_t"],
    ["query", "cursor"],
    ["query", "q"],
  ]);
  const signing = detectSigning(op, members);
  assert.ok(signing);
  assert.deepEqual(signing.query, ["chal_t"]);
  assert.deepEqual(signing.tokens, [{ in: "query", param: "chal_t" }]);
  op.signing = signing;
  markSignedParams(op);
  assert.equal(op.params.find((p) => p.name === "chal_t").derived, "signer");
  assert.equal(op.params.find((p) => p.name === "cursor").derived, undefined);
});

function csrfScheme(html, headerName, token) {
  const page = exchange("https://site.test/", {
    resourceType: "document",
    responseBody: html,
  });
  const post = member("https://site.test/api/save", {
    method: "POST",
    requestHeaders: { [headerName]: token, cookie: "session-id=s1" },
  });
  const op = operation([["header", headerName]], { method: "POST", path: "/api/save" });
  const entries = [{ operation: op, members: [post] }];
  traceDependencies({ members: entries, documents: [{ pageId: "home", exchange: page }] });
  return inferSecurity(entries).find((s) => s.type === "csrf");
}

test("CSRF header traces to a hidden input", () => {
  const scheme = csrfScheme(
    '<form><input type="hidden" name="anti-csrftoken-a2z" value="tok-xyz-123"></form>',
    "anti-csrftoken-a2z",
    "tok-xyz-123",
  );
  assert.equal(scheme?.key, "anti-csrftoken-a2z");
  assert.deepEqual(scheme.source, {
    kind: "hidden-input",
    name: "anti-csrftoken-a2z",
    selector: 'input[type="hidden"][name="anti-csrftoken-a2z"]',
  });
});

test("CSRF header traces to an inline script", () => {
  const scheme = csrfScheme(
    '<script>window.csrf = "csrf-abc-999"</script>',
    "x-csrf-token",
    "csrf-abc-999",
  );
  assert.deepEqual(scheme?.source, { kind: "inline-script", name: "csrf" });
});

test("signer keeps file:line and adds a hash-free module and function", () => {
  const url = "https://s.ltrbxd.com/static/js/signer.deadbeef.js";
  const stack = [{ url, functionName: "signRequest", line: 42 }];
  const members = [
    member("https://letterboxd.com/api/v0/films?signature=3fa9c1b2d4e5f60718293a4b", {
      initiator: { type: "script", stack },
    }),
  ];
  const signing = detectSigning(operation([["query", "signature"]]), members);
  assert.deepEqual(signing?.initiator, {
    url,
    functionName: "signRequest",
    line: 42,
    module: "s.ltrbxd.com/static/js/signer.js",
  });
});
