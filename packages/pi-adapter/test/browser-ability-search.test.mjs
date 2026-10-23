import assert from "node:assert/strict";
import test from "node:test";
import { matchAbilities } from "../dist/browser-ability-search.js";

test("tool_search finds abilities inside browser_code, such as history", () => {
  assert.match(matchAbilities("browser history")[0].call, /browser\.history\.search/);
  assert.match(matchAbilities("bookmarks")[0].call, /browser\.bookmarks/);
  assert.match(matchAbilities("remove many items in bulk")[0].call, /siteMapper/);
  assert.deepEqual(matchAbilities("quantum chromodynamics"), []);
});
