import assert from "node:assert/strict";
import test from "node:test";
import { redactHarBody, secretHeaderValues, toHar } from "../dist/native-browser-network-format.js";
import { clearGlobal, harGlobal, recordGlobalEntry } from "../dist/network-store.js";

const entry = {
  id: "1",
  url: "https://example.com/api?access_token=secret-token&q=user%40example.com",
  method: "POST",
  type: "Fetch",
  startedAt: Date.now(),
  requestHeaders: {
    Cookie: "sid=secret-cookie",
    Authorization: "Bearer secret-auth",
    "X-API-Key": "secret-api-key",
    "Content-Type": "application/json",
  },
  responseHeaders: {
    "Set-Cookie": "session=secret-session; Path=/",
    "Content-Type": "application/json",
  },
  status: 201,
  statusText: "Created",
  mimeType: "application/json",
  requestBody: JSON.stringify({ access_token: "secret-body-token", name: "ok" }),
  body: JSON.stringify({
    email: "user@example.com",
    token: "secret-response-token",
    debug: "Bearer secret-auth",
    echoed: "sid=secret-cookie",
    note: "prefix secret-api-key suffix",
  }),
  size: 42,
  bodyBytes: 42,
  durationMs: 12,
  done: true,
};

test("HAR redacts headers, cookies, URLs, queries and bodies by default", () => {
  const har = toHar([entry]);
  const text = JSON.stringify(har);
  for (const secret of [
    "secret-token",
    "secret-cookie",
    "secret-auth",
    "secret-api-key",
    "secret-session",
    "secret-body-token",
    "secret-response-token",
    "user@example.com",
  ])
    assert.doesNotMatch(text, new RegExp(secret), secret);
  const row = har.log.entries[0];
  assert.equal(row.response.status, 201);
  assert.equal(row.response.content.mimeType, "application/json");
  assert.equal(row.startedDateTime, new Date(entry.startedAt).toISOString());
  assert.equal(
    row.request.headers.find((header) => header.name === "Content-Type")?.value,
    "application/json",
  );
  assert.equal(row.request.queryString.length, 2);
});

test("echoed secrets are redacted in other encodings", () => {
  const cookie = "secret-cookie-value";
  const token = "secret-auth-token";
  const key = "secret/api+key==";
  const secrets = secretHeaderValues({
    Cookie: `sid=${cookie}`,
    Authorization: `Bearer ${token}`,
    "X-API-Key": key,
  });
  const body = JSON.stringify({
    note: cookie,
    debug: token,
    encoded: encodeURIComponent(key),
    b64: Buffer.from(token).toString("base64"),
    b64url: Buffer.from(token).toString("base64url"),
    fullCookie: `sid=${cookie}`,
    fullAuth: `Bearer ${token}`,
  });
  const redacted = redactHarBody(body, false, secrets);
  for (const secret of [
    cookie,
    token,
    encodeURIComponent(key),
    Buffer.from(token).toString("base64"),
    Buffer.from(token).toString("base64url"),
    `sid=${cookie}`,
    `Bearer ${token}`,
  ])
    assert.doesNotMatch(redacted, new RegExp(escapeRegExp(secret)), secret);
  const unicode = redactHarBody(`note=${token.replaceAll("e", "\\u0065")}`, false, secrets);
  assert.doesNotMatch(unicode, /secret-auth-token/);
  const jsonUnicode = redactHarBody(
    `{"note":"${token.replaceAll("e", "\\u0065")}"}`,
    false,
    secrets,
  );
  assert.doesNotMatch(jsonUnicode, /secret-auth-token/);
  assert.equal(redactHarBody(body, true, secrets), body);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a short secret header value is redacted only where it stands alone", () => {
  const echoed = toHar([
    {
      ...entry,
      id: "2",
      requestHeaders: { "X-CSRF-Token": "ab12" },
      responseHeaders: { "Content-Type": "text/plain" },
      requestBody: undefined,
      body: "ab12 and ab12more and (ab12)",
      mimeType: "text/plain",
    },
  ]);
  assert.equal(
    echoed.log.entries[0].response.content.text,
    "<redacted> and ab12more and (<redacted>)",
  );
});

test("raw: true keeps the original values", () => {
  const text = JSON.stringify(toHar([entry], { raw: true }));
  for (const value of ["secret-token", "secret-cookie", "secret-body-token", "user@example.com"])
    assert.match(text, new RegExp(value));
});

test("the global store HAR redacts the same way", () => {
  clearGlobal();
  recordGlobalEntry(1, entry);
  const redacted = JSON.stringify(harGlobal());
  for (const secret of ["secret-cookie", "secret-auth", "secret-body-token"])
    assert.doesNotMatch(redacted, new RegExp(secret), secret);
  const raw = JSON.stringify(harGlobal({ raw: true }));
  assert.match(raw, /secret-cookie/);
  assert.match(raw, /secret-body-token/);
});
