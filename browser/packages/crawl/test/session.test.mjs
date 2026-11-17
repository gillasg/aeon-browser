import assert from "node:assert/strict";
import test from "node:test";
import { cookieHeader } from "../dist/session.js";

const session = (cookies) => ({ site: "example.com", savedAt: "", cookies });
const cookie = (domain, extra = {}) => ({ name: "sid", value: "1", domain, path: "/", ...extra });

test("host-only cookie matches only its exact host", () => {
  const s = session([cookie("example.com")]);
  assert.equal(cookieHeader(s, "https://example.com/x"), "sid=1");
  assert.equal(cookieHeader(s, "https://sub.example.com/x"), "");
});

test("an explicit hostOnly flag wins even with a leading dot", () => {
  const s = session([cookie(".example.com", { hostOnly: true })]);
  assert.equal(cookieHeader(s, "https://example.com/x"), "sid=1");
  assert.equal(cookieHeader(s, "https://www.example.com/x"), "");
});

test("a dot-domain cookie matches the host and its subdomains", () => {
  const s = session([cookie(".example.com")]);
  assert.equal(cookieHeader(s, "https://example.com/x"), "sid=1");
  assert.equal(cookieHeader(s, "https://deep.sub.example.com/x"), "sid=1");
});

test("a lookalike suffix never matches a domain cookie", () => {
  const s = session([cookie(".example.com"), cookie("example.com")]);
  assert.equal(cookieHeader(s, "https://evil-example.com/x"), "");
  assert.equal(cookieHeader(s, "https://notexample.com/x"), "");
  assert.equal(cookieHeader(s, "https://example.com.evil.test/x"), "");
});
