import assert from "node:assert/strict";
import test from "node:test";
import { assertNoSealedSecrets } from "../dist/index.js";

test("mcp.call args with a sealed handle are refused", () => {
  assert.throws(
    () => assertNoSealedSecrets({ text: "graft-sealed:abc123def456" }, "mcp.call notes.add"),
    /SECRET_EGRESS: mcp\.call notes\.add carries a sealed secret/,
  );
  assert.throws(
    () => assertNoSealedSecrets({ nested: [{ "graft-sealed:abc123def456": 1 }] }, "mcp.call x.y"),
    /SECRET_EGRESS/,
  );
});

test("mcp.call args with a raw bearer or JWT are refused", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl";
  assert.throws(() => assertNoSealedSecrets({ token: jwt }, "mcp.call"), /raw credential/);
  assert.throws(
    () => assertNoSealedSecrets({ h: "Bearer abcdefghijklmnop" }, "mcp.call"),
    /raw credential/,
  );
});

test("ordinary mcp.call args pass", () => {
  assert.doesNotThrow(() =>
    assertNoSealedSecrets({ title: "Weekly notes", tags: ["a", "b"], count: 3 }, "mcp.call"),
  );
});
