import assert from "node:assert/strict";
import test from "node:test";
import { handoffLine, statusHandoffLines } from "../src/handoff-lines.ts";

test("graft tabs prints the pending hand-off under its tab row", () => {
  assert.equal(
    handoffLine({ message: "Enter the 2FA code", startedAt: 0 }, 130_000),
    "  waiting on you: Enter the 2FA code · 2m 10s",
  );
});

test("the message is clipped to 80 characters", () => {
  const line = handoffLine({ message: "a".repeat(300), startedAt: 0 }, 5_000);
  const message = line.slice("  waiting on you: ".length, line.lastIndexOf(" · "));
  assert.equal(message.length, 80);
  assert.ok(message.endsWith("…"));
});

test("graft status lists only tabs that wait on the user", () => {
  const lines = statusHandoffLines(
    [
      { target: { tabId: 7 }, title: "Bank", handoff: { message: "Sign in", startedAt: 0 } },
      { target: { tabId: 8 }, title: "News" },
    ],
    45_000,
  );
  assert.deepEqual(lines, ["Tab 7 Bank\n  waiting on you: Sign in · 45s"]);
});
