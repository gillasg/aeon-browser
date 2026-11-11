import assert from "node:assert/strict";
import test from "node:test";
import { allowlistEntries, rawColorHits, scanRawColors } from "./check-raw-color.mjs";

test("a raw colour fails and a comment or bare rgb() does not", () => {
  assert.deepEqual(rawColorHits("a { color: #fff; background: rgb(0 0 0 / 32%); }"), [
    "#fff",
    "rgb(0",
  ]);
  assert.deepEqual(rawColorHits("/* #abc */\n// #def\na { color: var(--aeon-text); }"), []);
  assert.deepEqual(rawColorHits('note rgb() and "rgba(" + value'), []);
  assert.deepEqual(allowlistEntries("# note\n\napps/example.css\n"), ["apps/example.css"]);
});

test("the scanned extension styles have no raw colour", async () => {
  assert.deepEqual(await scanRawColors(), []);
});
