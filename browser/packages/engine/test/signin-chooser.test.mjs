import assert from "node:assert/strict";
import test from "node:test";

// The page answers: the chooser scan, the click, then the form scan after the click.
let page = {};
const clicks = [];
const fake = {
  run: async (_tabId, expression) => {
    if (expression.includes("entries.push")) return page.chooser;
    clicks.push(/="([^"]+)"/.exec(expression)?.[1]);
    page.chooser = page.after;
    return true;
  },
  scan: async () => page.form,
};
globalThis.chrome = {
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  tabs: { onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
};
const { matchAccount, passAccountChooser } =
  await import("../dist/native-browser-signin-chooser.js");

const entries = [{ label: "maya.whitfield97" }, { label: "iceman.exe" }];

test("matchAccount: a name, an email's local part, or the only entry", () => {
  assert.equal(matchAccount(entries, "iceman.exe"), 1);
  assert.equal(matchAccount(entries, "Maya.Whitfield97@gmail.com"), 0);
  assert.equal(matchAccount(entries, undefined), -1);
  assert.equal(matchAccount([{ label: "a@b.co" }], undefined), 0);
  assert.equal(matchAccount(entries, "nobody"), -1);
});

test("passAccountChooser clicks the wanted account and returns the form behind it", async () => {
  clicks.length = 0;
  page = {
    chooser: { entries, other: true },
    after: null,
    form: { user: true, password: true, code: false, url: "https://x.test/login" },
  };
  const outcome = await passAccountChooser(1, "iceman.exe", fake);
  assert.equal(outcome.kind, "picked");
  assert.equal(outcome.account, "iceman.exe");
  assert.equal(outcome.fields.password, true);
  assert.deepEqual(clicks, ["1"]);
});

test("passAccountChooser asks which account when several are listed and none was named", async () => {
  clicks.length = 0;
  page = { chooser: { entries, other: false }, after: null, form: null };
  const outcome = await passAccountChooser(1, undefined, fake);
  assert.deepEqual(outcome, { kind: "choose", accounts: ["maya.whitfield97", "iceman.exe"] });
  assert.deepEqual(clicks, []);
});

test("passAccountChooser uses another account when the wanted one is not listed", async () => {
  clicks.length = 0;
  page = {
    chooser: { entries, other: true },
    after: null,
    form: { user: true, password: true, code: false, url: "https://x.test/login" },
  };
  const outcome = await passAccountChooser(1, "someone@else.com", fake);
  assert.equal(outcome.kind, "picked");
  assert.deepEqual(clicks, ["other"]);
});

test("no chooser on the page: nothing happens", async () => {
  page = { chooser: null };
  assert.deepEqual(await passAccountChooser(1, "iceman.exe", fake), { kind: "none" });
});
