import assert from "node:assert/strict";
import test from "node:test";
import { vaultSubmissionSucceeded } from "../packages/engine/dist/native-browser-vault.js";

// A fixture signup form: success is the page's own evidence, never a toast. The password field
// is gone after a navigation or an in-page submit; a failed request leaves it in place.
const form = (url, hasPassword) => ({
  url,
  site: "example.com",
  hasPassword,
  password: hasPassword ? "secret" : "",
  username: "me@example.com",
  signup: true,
});

test("success comes from navigation or a removed password field", () => {
  assert.equal(vaultSubmissionSucceeded(form("https://example.com/welcome", false)), true);
  assert.equal(vaultSubmissionSucceeded(form("https://example.com/signup", false)), true);
});

test("a failed signup keeps the password form and is not offered for saving", () => {
  assert.equal(vaultSubmissionSucceeded(form("https://example.com/signup", true)), false);
  assert.equal(vaultSubmissionSucceeded(undefined), false);
});

test("Chrome's suggestions open from the empty username, else the password", async () => {
  const { chromeField } = await import("../packages/engine/dist/native-browser-signin-chrome.js");
  const screen = (fields) => ({
    user: false,
    userValue: "",
    password: false,
    code: false,
    ...fields,
  });
  assert.equal(chromeField(screen({ user: true, password: true })), "user");
  assert.equal(chromeField(screen({ user: true, userValue: "me", password: true })), "password");
  assert.equal(chromeField(screen({ password: true })), "password");
  assert.equal(chromeField(screen({ user: true })), "user");
  assert.equal(chromeField(screen({ code: true })), undefined);
});

test("a Chrome fill counts only when the screen's own field filled", async () => {
  const { chromeFilled } = await import("../packages/engine/dist/native-browser-signin-chrome.js");
  const withPassword = { user: true, userValue: "", password: true };
  assert.equal(chromeFilled(withPassword, { ...withPassword, passwordFilled: true }), true);
  assert.equal(chromeFilled(withPassword, { ...withPassword, userValue: "me" }), false);
  const userOnly = { user: true, userValue: "", password: false };
  assert.equal(chromeFilled(userOnly, { ...userOnly, userValue: "me@example.com" }), true);
  assert.equal(chromeFilled(userOnly, userOnly), false);
  assert.equal(chromeFilled(userOnly, undefined), false);
  // A suggestion Chrome only shows is not filled: the page has no value until a real click.
  assert.equal(chromeFilled(withPassword, { ...withPassword, autofill: true }), false);
});

test("Enter on a filled field that submitted the form counts as submitted", async () => {
  const { screenLeft } = await import("../packages/engine/dist/native-browser-signin-chrome.js");
  const before = { url: "http://x/login", user: true, userValue: "", password: true };
  assert.equal(screenLeft(before, { ...before, url: "http://x/home", password: false }), true);
  assert.equal(screenLeft(before, { ...before, password: false }), true);
  assert.equal(screenLeft(before, undefined), true);
  assert.equal(screenLeft(before, before), false);
});
