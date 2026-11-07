import assert from "node:assert/strict";
import test from "node:test";
import { createRedactor } from "../dist/redact.js";

test("redaction stays fast on huge bodies of digits, dots and word characters", () => {
  const redactor = createRedactor();
  const bodies = [
    Array.from({ length: 200_000 }, (_, i) => i % 10).join(".") + "x",
    "a".repeat(400_000),
    "abc.def-12 ".repeat(40_000),
  ];
  for (const body of bodies) {
    const began = Date.now();
    redactor.text(body);
    assert.ok(Date.now() - began < 1000, `took ${Date.now() - began} ms on ${body.length} chars`);
  }
});

test("redaction still hides emails, phones, cards and tokens", () => {
  const out = createRedactor().text(
    "mail john.doe+x@mail.example.com call +1 (555) 123-4567 card 4111 1111 1111 1111 jwt eyJabcdefg.hijklmnop.qrstuvwxyz",
  );
  assert.equal(out, "mail <email> call <phone> card <card> jwt <jwt>");
});
