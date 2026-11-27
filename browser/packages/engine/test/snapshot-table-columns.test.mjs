// Tables print column names once on the table line; data rows print values only, in column order.
import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticNodes } from "../dist/native-browser-observation.js";
import { renderState } from "../dist/observe/render.js";
import { buildSemanticTree } from "../dist/observe/tree.js";

let seq = 0;
function el(role, name, children = [], backend) {
  const nodeId = `t${++seq}`;
  const flat = [
    {
      nodeId,
      backendDOMNodeId: backend ?? 5000 + seq,
      role: { value: role },
      name: { value: name },
    },
  ];
  for (const [head, ...rest] of children) flat.push({ ...head, parentId: nodeId }, ...rest);
  return flat;
}

function view(ax) {
  const shown = createSemanticNodes(ax, {}).nodes;
  const tree = buildSemanticTree({ ax, shown, url: "https://example.com/t" });
  const out = renderState(tree, { budget: 8000 });
  return typeof out === "string" ? out : String(out.text);
}

function table(headers) {
  const names = ["Order", "Item", "Status", "Total"];
  const head = el(
    "row",
    "",
    names.map((name) => el(headers ? "columnheader" : "cell", name)),
  );
  const rows = [1, 2, 3].map((n) =>
    el("row", "", [
      el("cell", `#${n}`),
      el("cell", `Cable ${n}`),
      el("cell", ""),
      el("cell", `USD ${n}.00`),
      el("button", "Return", [], 700 + n),
    ]),
  );
  const body = el("table", "Orders", [el("rowgroup", "", [head]), el("rowgroup", "", rows)]);
  return el("RootWebArea", "Orders", [el("main", "", [body])]);
}

test("a headed table prints its columns once and each row's values in order", () => {
  const text = view(table(true));
  assert.match(text, /table "Orders" \(3 rows\) columns: Order \| Item \| Status \| Total/, text);
  assert.match(text, /row "#2 \| Cable 2 \| \| USD 2.00"/, text);
  assert.equal(text.match(/Status/g).length, 1, text);
  assert.match(text, /\[702\] button "Return"/, text);
  assert.doesNotMatch(text, /row "Order/, text);
});

test("a table without headers keeps its short row names", () => {
  const text = view(table(false));
  assert.doesNotMatch(text, /columns:/, text);
  assert.match(text, /\[701\] button "Return"/, text);
});
