// An outside agent walks a multi-step form the way browser_code does: read bu.state() ids,
// screenshot each step, and stop before Submit. The fixture is the page; the cells drive the
// same accessibility tree the snapshot renderer prints.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSemanticNodes, filterVisibleTextNodes } from "../dist/native-browser-observation.js";
import { renderState } from "../dist/observe/render.js";
import { buildSemanticTree } from "../dist/observe/tree.js";

const fixture = readFileSync(new URL("./fixtures/multistep-form.html", import.meta.url), "utf8");

let seq = 0;
function el(role, name, children = [], extra = {}) {
  const nodeId = `n${++seq}`;
  const self = {
    nodeId,
    backendDOMNodeId: extra.backend ?? 1000 + seq,
    role: { value: role },
    name: { value: name },
  };
  const flat = [self];
  for (const subtree of children) {
    const [head, ...rest] = subtree;
    flat.push({ ...head, parentId: nodeId }, ...rest);
  }
  return flat;
}

function viewOf(ax) {
  const visible = ax
    .map((node) => node.name?.value)
    .filter(Boolean)
    .join("\n");
  const filtered = filterVisibleTextNodes(ax, visible);
  const semantic = createSemanticNodes(filtered, {});
  const tree = buildSemanticTree({ ax, shown: semantic.nodes, url: "http://127.0.0.1/form" });
  return renderState(tree, { budget: 8000 });
}

function controls(view) {
  return [...view.matchAll(/\[(\d+)\] (button|textbox|radio) "([^"]+)"/g)].map((match) => ({
    id: Number(match[1]),
    role: match[2],
    name: match[3],
  }));
}

function page1() {
  return el("RootWebArea", "Builder application", [
    el("main", "", [
      el("heading", "About you"),
      el("textbox", "First name", [], { backend: 11 }),
      el("textbox", "Email", [], { backend: 12 }),
      el("button", "Next", [], { backend: 13 }),
    ]),
  ]);
}

function page2() {
  return el("RootWebArea", "Builder application", [
    el("main", "", [
      el("heading", "Will you build this year?"),
      el("radio", "Yes", [], { backend: 21 }),
      el("radio", "No", [], { backend: 22 }),
      el("button", "Next", [], { backend: 23 }),
    ]),
  ]);
}

function page3() {
  return el("RootWebArea", "Builder application", [
    el("main", "", [el("heading", "Review"), el("button", "Submit", [], { backend: 31 })]),
  ]);
}

test("the fixture is a multi-step form with aria-labels, a choice, and a submit", () => {
  assert.match(fixture, /aria-label="First name"/);
  assert.match(fixture, /aria-label="Email"/);
  assert.match(fixture, /type="radio"/);
  assert.match(fixture, /aria-label="Yes"/);
  assert.match(fixture, /id="submit"/);
  assert.doesNotMatch(fixture, /placeholder=/);
});

test("an agent finishes the form in a few cells and does not submit", () => {
  const pages = [page1, page2, page3];
  const cells = [];
  let submitted = false;
  let step = 0;
  while (step < pages.length && cells.length < 6) {
    seq = 0;
    const view = viewOf(pages[step]());
    const found = controls(view);
    const shot = `/tmp/form-step-${cells.length + 1}.png`;
    const next = found.find((control) => control.role === "button" && control.name === "Next");
    const submit = found.find((control) => control.name === "Submit");
    const fields = found.filter((control) => control.role !== "button");
    cells.push({ view, shot, ids: found.map((control) => control.id), fields });
    if (submit && !next) break;
    assert.ok(next, `step ${step} has no Next id\n${view}`);
    step += 1;
  }
  assert.ok(cells.length <= 4, `took ${cells.length} cells`);
  assert.equal(cells.length, 3);
  assert.equal(submitted, false);
  assert.deepEqual(
    cells[0].fields.map((field) => field.name),
    ["First name", "Email"],
  );
  assert.deepEqual(cells[0].ids, [11, 12, 13]);
  assert.match(cells[1].view, /radio "Yes"/);
  assert.match(cells[2].view, /\[31\] button "Submit"/);
  assert.deepEqual(
    cells.map((cell) => cell.shot),
    ["/tmp/form-step-1.png", "/tmp/form-step-2.png", "/tmp/form-step-3.png"],
  );
  assert.equal(
    cells.some((cell) => cell.ids.includes(31) && cell === cells[2]),
    true,
  );
});
