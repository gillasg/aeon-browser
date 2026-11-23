// Layer 2 contract: structured errors. The failure set is closed: every code names its owner
// (model, page, user or ours), carries one recovery hint, and maps to at most one safe next call.
// A code outside the set is ours, never a silent pass.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ERRORS,
  ERROR_CODES,
  NEXT_CALLS,
  describeError,
  errorHint,
  errorNextCall,
  errorOwner,
  isErrorCode,
} from "@browserkit/protocol";
import { KERNEL_ERRORS } from "../../dist/kernel-errors.js";

const OWNERS = new Set(["model", "page", "user", "ours"]);

test("every code is UPPER_SNAKE and names exactly one owner and one non-empty hint", () => {
  assert.ok(ERROR_CODES.length > 20, "the closed set is not empty");
  for (const code of ERROR_CODES) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, code);
    const entry = ERRORS[code];
    assert.equal(entry.length, 2, `${code} carries [owner, hint]`);
    assert.ok(OWNERS.has(entry[0]), `${code} has owner ${entry[0]}`);
    assert.ok(typeof entry[1] === "string" && entry[1].trim().length > 0, `${code} hint`);
  }
});

test("a known code reports its owner and hint, and the kernel exposes the same hints", () => {
  for (const code of ERROR_CODES) {
    assert.equal(errorOwner(code), ERRORS[code][0]);
    assert.equal(errorHint(code), ERRORS[code][1]);
    assert.equal(KERNEL_ERRORS[code], ERRORS[code][1]);
  }
});

test("an unnamed or unknown failure is ours, with no hint", () => {
  assert.ok(ERROR_CODES.includes("INTERNAL"));
  assert.equal(errorOwner("INTERNAL"), "ours");
  for (const code of ["NOT_A_CODE", "toString", "__proto__", "constructor", ""]) {
    assert.equal(isErrorCode(code), false, code);
    assert.equal(errorOwner(code), "ours", code);
    assert.equal(errorHint(code), "", code);
  }
});

test("each safe next call is a read, a wait, a reload, help, or a page upload, never a click or fill", () => {
  for (const [code, call] of Object.entries(NEXT_CALLS)) {
    assert.ok(isErrorCode(code), `${code} is in the closed set`);
    assert.equal(typeof call, "string");
    assert.ok(call.length > 0, `${code} next call`);
    assert.doesNotMatch(call, /\b(click|fill|type|press)\(/, `${code}: ${call}`);
  }
});

test("errorNextCall agrees with NEXT_CALLS when no context is given", () => {
  for (const code of ERROR_CODES) assert.equal(errorNextCall(code), NEXT_CALLS[code] ?? "", code);
});

test("describeError is deterministic and always leads with the code and carries its hint", () => {
  for (const code of ERROR_CODES) {
    const first = describeError(code, "detail text");
    assert.equal(first, describeError(code, "detail text"), code);
    assert.ok(first.startsWith(`${code}: detail text`), code);
    assert.ok(first.includes(ERRORS[code][1]), `${code} hint appears in the message`);
  }
});

test("describeError with no detail prints the bare code, not a stray separator", () => {
  assert.ok(describeError("TIMEOUT").startsWith("TIMEOUT"));
  assert.equal(describeError("TIMEOUT").startsWith("TIMEOUT:"), false);
});
