import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR_CODES,
  ERRORS,
  NEXT_CALLS,
  NO_NEXT_REASON,
  describeError,
  effectNext,
  errorHint,
  errorNext,
  errorNextCall,
  isReadNext,
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

test("a next call is a read, a reload, a wait or ask_user, never an action that commits", () => {
  for (const [code, call] of Object.entries(NEXT_CALLS)) {
    assert.ok(code in ERRORS, code);
    assert.equal(isReadNext(call), true, `${code}: ${call}`);
    assert.equal(/click|fill|type|press/.test(call), false, code);
  }
  assert.equal(errorNextCall("INTERNAL"), "", "an unexpected failure names no call");
  assert.equal(isReadNext("await page.click(412)"), false);
  assert.equal(isReadNext("await page.clickAt(1, 2)"), false);
});

test("every error class has a next call or a reason there is none", () => {
  for (const code of ERROR_CODES) {
    const next = errorNext(code);
    if (next === null) {
      assert.ok(NO_NEXT_REASON[code]?.length > 20, code);
      assert.equal(errorNextCall(code), "", code);
    } else {
      assert.equal(isReadNext(next), true, `${code}: ${next}`);
      assert.equal(NO_NEXT_REASON[code], undefined, code);
    }
  }
});

test("an ambiguous target names a state read, not a click, and lists the matches", () => {
  const text = describeError("AMBIGUOUS_TARGET", '3 buttons named "Edit"', {
    target: { role: "button", name: "Edit" },
    candidates: [
      { id: 412, role: "button", name: "Edit", context: "row: Order 1182" },
      { id: 431, role: "button", name: "Edit", context: "row: Order 1175" },
    ],
  });
  assert.match(text, /\[412\] button "Edit" \(row: Order 1182\)/);
  assert.match(text, /\[431\] button "Edit" \(row: Order 1175\)/);
  assert.match(text, /Next: await bu\.state\(\{query: "Edit"\}\)/);
  assert.equal(text.includes("page.click"), false);
});

test("a non-confirmed effect names a read, and clickAt only when a child has the handler", () => {
  assert.equal(effectNext("confirmed", { op: "click", childPoint: { x: 4, y: 5 } }), null);
  assert.equal(effectNext("refused"), null);
  assert.equal(
    effectNext("suspected_noop", { op: "click", query: "Save" }),
    'await bu.state({query: "Save"})',
  );
  assert.equal(
    effectNext("suspected_noop", { op: "click", childPoint: { x: 12.4, y: 40 } }),
    "await page.clickAt(12, 40)",
  );
  assert.equal(
    effectNext("unverifiable", { op: "click", childPoint: { x: 12, y: 40 } }),
    "await bu.state()",
  );
  assert.equal(
    effectNext("suspected_noop", { op: "click", childPoint: { x: -1, y: 4 } }),
    "await bu.state()",
  );
});

test("random contexts never make next throw or return a write", () => {
  const junk = [
    "",
    "click",
    "await page.click(1)",
    "\n",
    '"',
    "{",
    "a".repeat(5000),
    "Edit",
    null,
    1,
    {},
    [],
  ];
  for (const code of ERROR_CODES) {
    for (const item of junk) {
      const ctx = {
        query: item,
        target: { name: item, role: item, selector: item, id: item },
        candidates: [{ id: item, role: item, name: item, context: item }],
        url: item,
        tabId: item,
      };
      let next = null;
      assert.doesNotThrow(() => {
        next = errorNext(code, ctx);
      }, code);
      if (next) assert.equal(isReadNext(next), true, `${code}: ${next}`);
    }
  }
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
