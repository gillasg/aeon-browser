import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptModel } from "../dist/index.js";
import { transcriptTurns, turnSummary } from "../dist/transcript-turn.js";

function entry(entryId, timestamp, message) {
  return { entryId, parentEntryId: null, category: "message", timestamp, message };
}

const user = (entryId, timestamp) =>
  entry(entryId, timestamp, { role: "user", content: [{ type: "text", text: "go" }] });

const toolCall = (entryId, timestamp, toolCallId) =>
  entry(entryId, timestamp, {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName: "read", arguments: {} }],
  });

const toolResult = (entryId, timestamp, toolCallId) =>
  entry(entryId, timestamp, {
    role: "tool",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });

test("an earlier turn's duration stays fixed while the next turn runs", () => {
  const transcript = new TranscriptModel();
  const t0 = Date.parse("2026-10-21T12:00:00Z");
  const at = (seconds) => t0 + seconds * 1000;

  // The first prompt's run has not settled (no idle event) when the next prompt is queued.
  transcript.applyAt(
    { kind: "entry-added", entry: user("u1", new Date(at(0)).toISOString()) },
    at(0),
  );
  transcript.applyAt(
    { kind: "entry-added", entry: toolCall("a1", new Date(at(1)).toISOString(), "t1") },
    at(1),
  );
  transcript.applyAt(
    { kind: "entry-added", entry: toolResult("r1", new Date(at(4)).toISOString(), "t1") },
    at(4),
  );

  transcript.applyAt(
    { kind: "entry-added", entry: user("u2", new Date(at(6)).toISOString()) },
    at(6),
  );
  // The first run's idle arrives after the next prompt was queued: it belongs to the first turn.
  transcript.applyAt({ kind: "run-state", state: "idle" }, at(6));
  transcript.applyAt(
    { kind: "entry-added", entry: toolCall("a2", new Date(at(7)).toISOString(), "t2") },
    at(7),
  );

  const turns = transcriptTurns(transcript.rows);
  const [first, second] = turns;
  assert.ok(first && second, "two turns");
  assert.equal(turns.length, 2);

  const firstAtEight = turnSummary(first, false, at(8));
  assert.deepEqual(firstAtEight, { active: false, seconds: 4 }, "ends with its own last event");
  assert.deepEqual(
    turnSummary(first, false, at(60)),
    firstAtEight,
    "the first turn never counts the next run's time",
  );

  assert.deepEqual(turnSummary(second, true, at(8)), { active: true, seconds: 2 });
  assert.deepEqual(turnSummary(second, true, at(60)), { active: true, seconds: 54 });
});
