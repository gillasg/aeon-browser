import assert from "node:assert/strict";
import test from "node:test";
import { profileArgs, profileDirectory } from "../apps/bridge/dist/commands/profile.js";

test("the managed profile is separate, fresh and extension-free", () => {
  const directory = profileDirectory();
  assert.match(directory, /profile$/);
  const args = profileArgs(directory, "https://example.com");
  assert.ok(args.includes(`--user-data-dir=${directory}`));
  assert.ok(args.includes("--disable-extensions"));
  assert.ok(args.includes("--no-first-run"));
  assert.equal(args.at(-1), "https://example.com");
});

test("the managed profile launches with no automation tells", () => {
  const args = profileArgs(profileDirectory(), "https://example.com");
  // Each of these makes navigator.webdriver true, shows the automation infobar, exposes a debug
  // port, or changes rendering in a way bot checks score.
  const tells = [
    /^--enable-automation/,
    /^--remote-debugging-(port|pipe)/,
    /^--headless/,
    /^--disable-blink-features/,
    /^--user-agent=/,
    /^--lang=/,
    /^--window-size=/,
    /^--test-type/,
    /^--no-sandbox/,
  ];
  for (const arg of args)
    for (const tell of tells)
      assert.ok(!tell.test(arg), `launch flag ${arg} is an automation tell`);
});
