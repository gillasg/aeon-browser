import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("a status request does not start a bridge", () => {
  const source = readFileSync(new URL("../src/commands/browser.ts", import.meta.url), "utf8");
  const status = source.slice(
    source.indexOf("async function status"),
    source.indexOf("async function journal"),
  );
  assert.match(status, /launch:\s*false/);
  assert.equal(status.includes("ensureBridge"), false);
});
