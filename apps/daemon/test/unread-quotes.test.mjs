import assert from "node:assert/strict";
import test from "node:test";
import { quoteClaims, unreadLine, unreadQuotes } from "../dist/unread-quotes.js";

test("a quote that came back in a read is not flagged", () => {
  const read = ["Your application is pending, blocked on your Aadhaar verification."];
  const answer = 'The form says "pending, blocked on your Aadhaar".';
  assert.deepEqual(unreadQuotes(answer, read), []);
});

test("a quote no read contains is flagged, including curly quotes", () => {
  const answer = "It says “your application was approved” on the page.";
  assert.deepEqual(unreadQuotes(answer, ["Your application is pending."]), [
    "your application was approved",
  ]);
  assert.deepEqual(unreadQuotes('It says "Your Application Was Approved".', []), [
    "Your Application Was Approved",
  ]);
});

test("the user's own words count as read", () => {
  const answer = 'I searched for "standing desk".';
  assert.deepEqual(unreadQuotes(answer, ["find me a standing desk under 300"]), []);
});

test("code quotes and short quotes are not claims about the page", () => {
  const answer = 'Run `page.getByText("Not in the page")` and look at "OK".';
  assert.deepEqual(unreadQuotes(answer, []), []);
  assert.deepEqual(quoteClaims('```\nconst label = "not a page claim";\n```'), []);
});

test("the line under the answer names at most two and counts the rest", () => {
  const claims = ["alpha text", "beta text", "gamma text", "delta text"];
  const line = unreadLine(claims);
  assert.match(line, /^Not read this run: “alpha text”, “beta text” \+2$/);
  assert.ok(line.length <= 200);
});

test("at most three quotes are checked and duplicates count once", () => {
  const answer = '"one claim" and "one claim" and "two claim" and "three claim" and "four claim"';
  assert.deepEqual(unreadQuotes(answer, []), ["one claim", "two claim", "three claim"]);
});
