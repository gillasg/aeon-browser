// Layer 2 contract: secret scrubbing. A credential the browser sent never reaches a HAR export,
// a step label or a recorded text by default. Raw is an explicit opt-in and says so. The round
// trip uses a loopback fixture server, so the server really echoes the secret back in its body.
import assert from "node:assert/strict";
import test from "node:test";
import { labelFor, labelForAction } from "../../dist/evidence/label.js";
import {
  redactHarText,
  redactHarUrl,
  redactSecretValues,
  secretHeaderValues,
  toHar,
} from "../../dist/native-browser-network-format.js";
import { startFixtureServer } from "./fixture-server.mjs";

const TOKEN = "tok_live_9f8e7d6c5b4a3210";
const SESSION = "sess-4471a0ce9b2d88f1";

async function capturedEntry(server) {
  const requestHeaders = {
    authorization: `Bearer ${TOKEN}`,
    cookie: `sid=${SESSION}; theme=dark`,
    accept: "application/json",
  };
  const url = `${server.origin}/echo?access_token=${TOKEN}&page=2`;
  const response = await fetch(url, { headers: requestHeaders });
  const body = await response.text();
  return {
    id: "req-1",
    url,
    method: "GET",
    type: "Fetch",
    startedAt: 1_700_000_000_000,
    requestHeaders,
    status: response.status,
    responseHeaders: { "content-type": "application/json" },
    mimeType: "application/json",
    body,
    size: body.length,
    durationMs: 3,
    done: true,
  };
}

test("a bearer token and session cookie sent to a local server never reach the default HAR", async () => {
  const server = await startFixtureServer();
  try {
    const entry = await capturedEntry(server);
    assert.ok(entry.body.includes(TOKEN), "the server echoed the token, so the test is real");
    const har = JSON.stringify(toHar([entry]));
    assert.equal(har.includes(TOKEN), false, "token leaked into HAR");
    assert.equal(har.includes(SESSION), false, "session id leaked into HAR");
    assert.ok(har.includes("page=2"), "non-secret query survives");
  } finally {
    await server.close();
  }
});

test("the same capture exports byte-identical HAR every time", async () => {
  const server = await startFixtureServer();
  try {
    const entry = await capturedEntry(server);
    assert.equal(JSON.stringify(toHar([entry])), JSON.stringify(toHar([entry])));
  } finally {
    await server.close();
  }
});

test("raw export is an explicit opt-in that keeps the secret", async () => {
  const server = await startFixtureServer();
  try {
    const entry = await capturedEntry(server);
    const raw = JSON.stringify(toHar([entry], { raw: true }));
    assert.ok(raw.includes(TOKEN), "raw keeps the value the caller asked for");
  } finally {
    await server.close();
  }
});

test("secret header values are collected from request and response headers", () => {
  const values = secretHeaderValues(
    { authorization: `Bearer ${TOKEN}`, accept: "text/html" },
    { "set-cookie": `sid=${SESSION}; Path=/` },
  );
  assert.ok(values.includes(TOKEN));
  assert.ok(values.includes(SESSION));
  assert.equal(
    values.some((value) => value.includes("text/html")),
    false,
    "a non-secret header is not collected",
  );
});

test("a secret echoed in text is replaced, and a short secret only where it stands alone", () => {
  assert.equal(
    redactSecretValues(`token=${TOKEN} again ${TOKEN}`, [TOKEN]),
    "token=<redacted> again <redacted>",
  );
  assert.equal(
    redactSecretValues("concatenate cat", ["cat"]),
    "concatenate <redacted>",
    "a short value inside a word is left alone",
  );
});

test("query secrets are redacted from URLs while other parameters are kept", () => {
  const scrubbed = redactHarUrl(
    `https://api.example.test/v1?api_key=abc123&q=shoes&token=${TOKEN}`,
  );
  assert.equal(scrubbed.includes(TOKEN), false);
  assert.ok(scrubbed.includes("q=shoes"));
  assert.equal(scrubbed.includes("%3C"), false, "the placeholder is written readable");
  assert.ok(scrubbed.includes("<redacted>"));
});

test("recognisable card numbers, emails, phone numbers and JWTs are scrubbed from text", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r";
  const scrubbed = redactHarText(
    `card 4111 1111 1111 1111 mail jane.doe@mail.example phone +1 415 555 0134 ${jwt}`,
  );
  for (const leak of ["4111 1111 1111 1111", "jane.doe@", "555 0134", "eyJhbGci"])
    assert.equal(scrubbed.includes(leak), false, leak);
});

test("a digit run that fails the Luhn check is still scrubbed, so the scrubber fails closed", () => {
  assert.equal(redactHarText("order 4111 1111 1111 1112"), "order <redacted>");
});

test("a short number is kept: order ids and quantities are not scrubbed", () => {
  assert.equal(redactHarText("order 4821, qty 2"), "order 4821, qty 2");
});

test("text past the cap is replaced by a marker instead of being scanned", () => {
  const big = "x".repeat(262_144 + 10);
  assert.match(redactHarText(big), /^\[truncated 10 chars; redactHarText cap 262144\]$/);
});

test("a typed password is never part of a step label, only the field name is", () => {
  const label = labelForAction({
    op: "fill",
    element: { role: "textbox", name: "Password" },
  });
  assert.equal(label, "Fill “Password” (sensitive)");
  assert.equal(
    labelFor({ kind: "fill", target: { role: "textbox", name: "One-time code" } }),
    "Fill “One-time code” (sensitive)",
  );
});

test("a navigate label keeps the host and drops the path and query", () => {
  const label = labelFor({
    kind: "navigate",
    url: `https://bank.example.test/login?session=${SESSION}`,
  });
  assert.equal(label, "Open bank.example.test");
  assert.equal(label.includes(SESSION), false);
});
