import assert from "node:assert/strict";
import test from "node:test";
import {
  ambiguousCandidates,
  ambiguousError,
  nameScore,
  nearestCandidates,
  notFoundError,
  openerCandidate,
} from "../dist/native-browser-candidates.js";

function node(id, role, name, extra = {}) {
  return {
    nodeId: String(id),
    backendDOMNodeId: id,
    role: { value: role },
    name: { value: name },
    ...extra,
  };
}

test("name similarity prefers the same words", () => {
  assert.equal(nameScore("Edit", "Edit"), 100);
  assert.ok(nameScore("Edit", "Edit order") > nameScore("Edit", "Delete"));
  assert.equal(nameScore("Save", "Cancel"), 0);
});

test("an ambiguous name lists the matches and their rows, not a click", () => {
  const row = node(1, "row", "Order 1182");
  const edit = node(412, "button", "Edit", { parentId: "1" });
  const other = node(431, "button", "Edit", { parentId: "9" });
  const tree = [row, edit, other, node(9, "row", "Order 1175")];
  const candidates = ambiguousCandidates(tree, [edit, other]);
  assert.deepEqual(
    candidates.map((item) => item.id),
    [412, 431],
  );
  assert.equal(candidates[0].context, "row: Order 1182");
  const error = ambiguousError(tree, [edit, other], { role: "button", name: "Edit" });
  assert.equal(error.message, "AMBIGUOUS_TARGET");
  assert.equal(error.recovery.target.name, "Edit");
  assert.equal(error.recovery.candidates.length, 2);
});

test("a missing name offers the nearest control of the same role", () => {
  const tree = [
    node(10, "button", "Save draft"),
    node(11, "heading", "Save"),
    node(12, "button", "Cancel"),
  ];
  const nearest = nearestCandidates(tree, "button", "Save");
  assert.equal(nearest[0].id, 10);
  assert.equal(
    nearest.some((item) => item.id === 11),
    false,
  );
  const error = notFoundError(tree, "button", "Save");
  assert.equal(error.message, "TARGET_NOT_FOUND");
  assert.equal(error.recovery.candidates[0].id, 10);
});

test("a hidden control points at the button that opens its container", () => {
  const toggle = node(7, "button", "Menu", {
    parentId: "2",
    properties: [{ name: "expanded", value: { value: false } }],
  });
  const hidden = node(8, "textbox", "Search", { parentId: "2" });
  const tree = [node(2, "group", "Toolbar"), toggle, hidden];
  const opener = openerCandidate(tree, hidden);
  assert.equal(opener.id, 7);
  assert.equal(opener.name, "Menu");
  assert.equal(openerCandidate(tree, undefined), undefined);
});

test("candidates stay at eight", () => {
  const matches = Array.from({ length: 12 }, (_, index) => node(index + 1, "button", "Edit"));
  assert.equal(ambiguousCandidates(matches, matches).length, 8);
});
