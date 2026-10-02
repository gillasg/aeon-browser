import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptModel } from "../dist/transcript-model.js";

test("branch replacement removes obsolete live tool rows instead of appending a second transcript", () => {
  const model = new TranscriptModel();
  model.apply({ kind: "tool-start", toolCallId: "obsolete", toolName: "read", arguments: {} });
  assert.equal(model.rows.length, 1);
  model.apply({ kind: "view-replaced", entries: [], runState: "idle", contextUsage: null });
  assert.equal(model.rows.length, 0);
});
