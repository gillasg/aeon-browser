import assert from "node:assert/strict";
import test from "node:test";
import { SealVault, SEALED_RE, siteOf } from "../dist/native-browser-seal.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl";
const COOKIE = "sid=8f3a9c1d22e7b4a0f19d";
const CSRF = "csrf-4c1b7e9a20d3f58e";

function leaks(value, raw) {
  const text = JSON.stringify(value);
  return text.includes(raw) || String(value).includes(raw);
}

test("cookies are sealed: value never prints, handle stays stable", () => {
  const vault = new SealVault();
  const cookies = [{ name: "sid", value: COOKIE, domain: ".example.com", httpOnly: true }];
  const sealed = vault.sealValue(cookies, "https://example.com/", "cookies");
  assert.equal(leaks(sealed, COOKIE), false);
  assert.match(sealed[0].value, SEALED_RE);
  assert.equal(sealed[0].name, "sid");
  assert.equal(vault.sealValue(cookies, null, "cookies")[0].value, sealed[0].value);
});

test("page.tokens() csrf, auth headers and storage tokens are sealed", () => {
  const vault = new SealVault();
  const tokens = {
    csrf: [{ name: "x-csrf-token", value: CSRF, source: "meta" }],
    headers: { authorization: `Bearer ${JWT}`, "content-type": "application/json" },
    cookies: COOKIE,
    storage: { access_token: JWT, theme: "dark" },
  };
  const sealed = vault.sealValue(tokens, "https://app.example.com");
  for (const raw of [JWT, CSRF, COOKIE]) assert.equal(leaks(sealed, raw), false);
  assert.equal(sealed.headers["content-type"], "application/json");
  assert.equal(sealed.storage.theme, "dark");
});

test("network.get/list/export entries and session headers are sealed", () => {
  const vault = new SealVault();
  const list = [
    {
      url: "https://api.example.com/v1/me",
      method: "GET",
      status: 200,
      requestHeaders: { Cookie: COOKIE, Authorization: `Bearer ${JWT}`, Accept: "*/*" },
      responseHeaders: { "set-cookie": `${COOKIE}; HttpOnly` },
      responseBody: `{"user":"ann","token":"${JWT}"}`,
    },
  ];
  const sealed = vault.sealValue(list, null, "networkStore");
  assert.equal(leaks(sealed, JWT), false);
  assert.equal(leaks(sealed, COOKIE), false);
  assert.equal(sealed[0].url, "https://api.example.com/v1/me");
  assert.equal(sealed[0].requestHeaders.Accept, "*/*");
  assert.match(sealed[0].responseBody, /"user":"ann"/);
});

test("curl({secrets:true}) text never shows raw secrets", () => {
  const vault = new SealVault();
  const curl =
    `curl 'https://example.com/api' -H 'authorization: Bearer ${JWT}' ` +
    `-H 'x-csrf-token: ${CSRF}' -b '${COOKIE}' -H 'accept: */*'`;
  const sealed = vault.sealValue(curl, "https://example.com");
  for (const raw of [JWT, CSRF, COOKIE]) assert.equal(sealed.includes(raw), false, raw);
  assert.match(sealed, /accept: \*\/\*/);
  assert.match(sealed, /https:\/\/example\.com\/api/);
});

test("errors and toString built from a handle cannot leak the raw value", () => {
  const vault = new SealVault();
  const handle = vault.seal(JWT, "example.com");
  const error = new Error(`request failed with ${handle}`);
  assert.equal(error.message.includes(JWT), false);
  assert.equal(`${handle}`.includes(JWT), false);
});

test("same-site fetch replays sealed handles with the raw value", () => {
  const vault = new SealVault();
  const handle = vault.seal(JWT, siteOf("https://example.com"));
  const fetch = {
    url: "https://api.example.com/v1",
    headers: { authorization: `Bearer ${handle}` },
  };
  const released = vault.release(fetch, fetch.url, "fetch");
  assert.equal(released.headers.authorization, `Bearer ${JWT}`);
});

test("cross-origin fetch, goto and fill refuse sealed and raw secrets", () => {
  const vault = new SealVault();
  const handle = vault.seal(JWT, "example.com");
  const evil = "https://attacker.test/collect";
  assert.throws(() => vault.release({ url: evil, body: handle }, evil, "fetch"), /SECRET_EGRESS/);
  assert.throws(() => vault.release(`${evil}?t=${handle}`, evil, "goto"), /SECRET_EGRESS/);
  assert.throws(() => vault.release(`${evil}?t=${JWT}`, evil, "goto"), /SECRET_EGRESS/);
  assert.throws(() => vault.release(handle, "https://evil.example.org", "fill"), /SECRET_EGRESS/);
  assert.throws(
    () => vault.release("aeon-sealed:000000000000", "https://example.com", "fetch"),
    /SECRET_EGRESS/,
  );
});

test("mcp.call arguments (no destination site) refuse any sealed value", () => {
  const vault = new SealVault();
  const handle = vault.seal(COOKIE, "example.com");
  assert.throws(() => vault.release({ note: handle }, null, "mcp.call notes.add"), /SECRET_EGRESS/);
  assert.throws(() => vault.release({ note: COOKIE }, null, "mcp.call notes.add"), /SECRET_EGRESS/);
  assert.deepEqual(vault.release({ note: "hello" }, null, "mcp.call"), { note: "hello" });
});

test("non-secret egress passes untouched with no prompt", () => {
  const vault = new SealVault();
  vault.seal(JWT, "example.com");
  const body = { url: "https://other.test/search?q=shoes", body: '{"q":"shoes"}' };
  assert.deepEqual(vault.release(body, body.url, "fetch"), body);
  assert.equal(vault.release("hello world", "https://other.test", "fill"), "hello world");
  const plain = { title: "Inbox", items: [1, 2, 3], url: "https://example.com" };
  assert.deepEqual(new SealVault().sealValue(plain, null), plain);
});

test("siteOf groups subdomains and two-level suffixes", () => {
  assert.equal(siteOf("https://api.example.com/x"), "example.com");
  assert.equal(siteOf(".example.com"), "example.com");
  assert.equal(siteOf("https://www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteOf("localhost:3000"), "localhost");
});

test("DOM control descriptors keep their element token; real tokens still seal", () => {
  const vault = new SealVault();
  const control = { token: "ctrl-1", kind: "select", label: "Country" };
  assert.deepEqual(vault.sealValue(control, "example.com"), control);
  const found = { frame: 0, token: "ff12", selector: '[data-aeon-t="ff12"]', control: {} };
  assert.deepEqual(vault.sealValue(found, "example.com"), found);
  const secrets = vault.sealValue(
    {
      token: CSRF,
      csrf_token: CSRF + "x",
      access_token: JWT,
      headers: { Authorization: "Bearer abcdef0123456789xyz" },
      cookies: [{ name: "sid", value: COOKIE, domain: ".example.com" }],
    },
    "example.com",
  );
  for (const raw of [CSRF, JWT, COOKIE, "abcdef0123456789xyz"])
    assert.equal(leaks(secrets, raw), false);
  assert.match(secrets.token, SEALED_RE);
  assert.throws(() => vault.release(secrets, "https://evil.test", "fetch"), /SECRET_EGRESS/);
  assert.equal(vault.release(secrets.token, "https://api.example.com", "fetch"), CSRF);
});
