import assert from "node:assert/strict";
import test from "node:test";
import { parseRegistry } from "../dist/capability-parsing.js";

const good = {
  id: "cap_notes",
  kind: "mcp",
  displayName: "Notes",
  description: "Notes folder.",
  configReference: "registry",
  credentialReference: null,
  relatedSkillIds: [],
  verification: { state: "needs_check", checkedAt: null, summary: null },
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  endpoint: null,
  workingDirectory: null,
};
const raw = JSON.stringify({
  schemaVersion: 1,
  revision: 2,
  capabilities: [{ ...good, id: "notes" }, good],
});

test("a tolerant read skips one bad entry and keeps the rest", () => {
  const skipped = [];
  const registry = parseRegistry(raw, (index, reason) => skipped.push({ index, reason }));
  assert.deepEqual(
    registry.capabilities.map((c) => c.id),
    ["cap_notes"],
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].index, 0);
  assert.match(skipped[0].reason, /must start with cap_/);
});

test("a strict read (used before a change) still refuses the bad entry", () => {
  assert.throws(() => parseRegistry(raw), /must start with cap_/);
});
