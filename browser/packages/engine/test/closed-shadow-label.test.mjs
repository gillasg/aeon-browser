import assert from "node:assert/strict";
import test from "node:test";
import { labelAxMatches } from "../dist/native-browser-label-ax.js";

const node = (id, role, name, extra = {}) => ({
  nodeId: String(id),
  backendDOMNodeId: id,
  role: { value: role },
  name: { value: name },
  ...extra,
});

const tree = [
  node(1, "heading", "Secret code"),
  node(2, "StaticText", "Secret code"),
  node(3, "LabelText", "Secret code"),
  node(4, "textbox", "Secret code"),
  node(5, "button", "Unlock"),
  node(6, "textbox", "Secret code backup", { ignored: true }),
  { nodeId: "7", role: { value: "textbox" }, name: { value: "Secret code" } },
  node(8, "checkbox", "Remember  me"),
];

test("an exact label resolves only the labelled control, never headings or text", () => {
  assert.deepEqual(
    labelAxMatches(tree, "Secret code").map((n) => n.backendDOMNodeId),
    [4],
  );
});

test("a fuzzy label matches case-insensitive substrings of control names", () => {
  assert.deepEqual(
    labelAxMatches(tree, "secret", false).map((n) => n.backendDOMNodeId),
    [4],
  );
  assert.deepEqual(
    labelAxMatches(tree, "remember me", false).map((n) => n.backendDOMNodeId),
    [8],
  );
  assert.deepEqual(labelAxMatches(tree, "secret"), []);
});

test("buttons and other form roles resolve; empty labels match nothing", () => {
  assert.deepEqual(
    labelAxMatches(tree, "Unlock").map((n) => n.backendDOMNodeId),
    [5],
  );
  assert.deepEqual(labelAxMatches(tree, "  "), []);
});
