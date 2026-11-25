import assert from "node:assert/strict";
import test from "node:test";
import { codeIn } from "../dist/native-browser-inbox-code.js";
import { profileFieldFor } from "../dist/native-browser-profile.js";

test("sign-in codes are read from messages, payment approvals are not", () => {
  assert.equal(codeIn("Your GitHub launch code is 482913"), "482913");
  assert.equal(codeIn("G-551204 is your Google verification code."), "551204");
  assert.equal(codeIn("Use 7731 as your login code for Notion"), "7731");
  assert.equal(codeIn("OTP 553311 for a transaction of Rs. 4,999 on card ending 1234"), undefined);
  assert.equal(codeIn("Your order shipped in 2026"), undefined);
});

test("form fields map to profile fields by hint, label and saved names", () => {
  const field = (label, autocomplete = "") => ({
    index: 0,
    label,
    autocomplete,
    tag: "input",
    type: "text",
  });
  assert.equal(profileFieldFor(field("Given", "given-name"), []), "firstName");
  assert.equal(profileFieldFor(field("Last name"), []), "lastName");
  assert.equal(profileFieldFor(field("Customer name:"), []), "name");
  assert.equal(profileFieldFor(field("E-mail address *"), []), "email");
  assert.equal(profileFieldFor(field("Company name"), []), "company");
  assert.equal(profileFieldFor(field("ZIP / Postal code"), []), "postalCode");
  assert.equal(profileFieldFor(field("Passport city"), ["passportCity"]), "passportCity");
  assert.equal(profileFieldFor(field("Favourite colour"), []), undefined);
});

test("a sign-in form that sends to another site is refused by fillProfile's host check", async () => {
  const { foreignLoginHost, siteOf } = await import("../dist/native-browser-profile.js");
  assert.equal(
    foreignLoginHost("http://127.0.0.1:8080/login", "http://localhost:8080/collect"),
    "localhost",
  );
  assert.equal(
    foreignLoginHost("https://shop.example/login", "https://evil.test/steal"),
    "evil.test",
  );
  assert.equal(
    foreignLoginHost("https://www.shop.example/login", "https://auth.shop.example/s"),
    null,
  );
  assert.equal(foreignLoginHost("https://shop.example/login", "/session"), null);
  assert.equal(foreignLoginHost("https://shop.example/login", null), null);
  assert.equal(foreignLoginHost("https://shop.example/login", "javascript:void 0"), null);
  assert.equal(siteOf("www.shop.example.co.uk"), "example.co.uk");
  // Two IP addresses that share their last two octets are still two sites.
  assert.equal(foreignLoginHost("http://192.168.0.1/login", "http://10.0.0.1/collect"), "10.0.0.1");
  assert.equal(foreignLoginHost("http://127.0.0.1:8080/login", "http://127.0.0.1:9090/s"), null);
  assert.equal(siteOf("localhost"), "localhost");
});

test("every element action refuses a sign-in form that posts to another site", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/native-browser-input.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /refuseForeignLoginForm\(frame, node\.backendNodeId\)/);
  const ready = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/native-browser-input-ready.ts", import.meta.url), "utf8"),
  );
  assert.match(ready, /"FOREIGN_FORM"/);
});
