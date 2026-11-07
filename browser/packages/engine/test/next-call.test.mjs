import assert from "node:assert/strict";
import test from "node:test";
import {
  ERRORS,
  NEXT_CALLS,
  describeError,
  errorHint,
  errorNextCall,
  leadingCode,
} from "@browserkit/protocol";

// A refusal or a no-op should name one safe call the agent can paste, so it does not repeat the
// guess or escalate to something that commits. The calls live in one table in the protocol.

/** The failure kinds a run meets most, and the call that safely follows each. */
const COMMON = {
  TARGET_NOT_FOUND: "await bu.state()",
  TARGET_LOST: "await bu.state()",
  STALE_REF: "await bu.state()",
  TAB_DEAD: "browser.tabs()",
  PASSWORD_PAGE: "await page.reload()",
  TIMEOUT: "await bu.state()",
  BOT_WALL: "await bu.state()",
};

test("the common refusals each have a short hint and a safe next call", () => {
  for (const [code, call] of Object.entries(COMMON)) {
    assert.ok(errorHint(code).length > 0 && errorHint(code).length <= 240, code);
    assert.equal(errorNextCall(code), call, code);
  }
  // The user's own decision has no safe call to make: the hint says to tell them.
  assert.match(errorHint("SITE_BLOCKED"), /do not try another route/);
  assert.equal(errorNextCall("SITE_BLOCKED"), "");
});

test("a next call is a read, a reload or a wait, never an action that commits", () => {
  for (const [code, call] of Object.entries(NEXT_CALLS)) {
    assert.ok(code in ERRORS, code);
    assert.match(
      call,
      /^(await bu\.state\(\)|browser\.tabs\(\)|await page\.reload\(\)|await page\.waitForControl\(\))$/,
      code,
    );
  }
  assert.equal(errorNextCall("INTERNAL"), "", "an unexpected failure names no call");
});

test("every hint stays short enough to be read", () => {
  for (const [code, [, hint]] of Object.entries(ERRORS))
    assert.ok(hint.length <= 400, `${code}: ${hint.length} characters`);
  for (const code of Object.keys(COMMON)) assert.ok(errorHint(code).length <= 240, code);
});

test("a described failure carries its hint and its next call", () => {
  const text = describeError("TARGET_NOT_FOUND", "no button named Save");
  assert.equal(
    text,
    "TARGET_NOT_FOUND: no button named Save\nHint: " +
      errorHint("TARGET_NOT_FOUND") +
      "\nNext: await bu.state()",
  );
  assert.equal(describeError("SITE_BLOCKED"), "SITE_BLOCKED\nHint: " + errorHint("SITE_BLOCKED"));
  assert.equal(
    describeError("TARGET_LOST"),
    "TARGET_LOST\nHint: " + errorHint("TARGET_LOST") + "\nNext: await bu.state()",
  );
});

test("a narrow code leads to its shared code's next call", () => {
  assert.equal(leadingCode("NO_OPTION: no option named Blue"), "TARGET_NOT_FOUND");
  assert.equal(
    errorNextCall(leadingCode("NO_OPTION: no option named Blue") ?? ""),
    "await bu.state()",
  );
});
