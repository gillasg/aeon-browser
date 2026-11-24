// Snapshot diff baselines are dropped when their tab goes, and never pile up past the cap.
import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetTrees,
  keepTreeBaseline,
  MAX_TREE_BASELINES,
  treeBaseline,
  treeBaselineCount,
} from "../dist/native-browser-tree-baselines.js";

const key = (tabId, incarnation = 1) => `client/run/${tabId}/${incarnation}`;
const baseline = () => ({ documentEpoch: 1, nodes: new Map([[1, "a"]]) });

test("closing a tab forgets its baselines and keeps other tabs'", () => {
  keepTreeBaseline(key(5), baseline());
  keepTreeBaseline(key(5, 2), baseline());
  keepTreeBaseline(key(55), baseline());
  forgetTrees(5);
  assert.equal(treeBaseline(key(5)), undefined);
  assert.equal(treeBaseline(key(5, 2)), undefined);
  assert.ok(treeBaseline(key(55)));
  forgetTrees(55);
});

test("baselines are capped, the least recently kept dropped first", () => {
  for (let tab = 1000; tab < 1000 + MAX_TREE_BASELINES + 25; tab++)
    keepTreeBaseline(key(tab), baseline());
  assert.equal(treeBaselineCount(), MAX_TREE_BASELINES);
  assert.equal(treeBaseline(key(1000)), undefined);
  assert.ok(treeBaseline(key(1000 + MAX_TREE_BASELINES + 24)));
});
