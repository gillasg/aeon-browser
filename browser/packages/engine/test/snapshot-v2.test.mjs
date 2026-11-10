// Snapshot v2: containers, named rows, and a character budget. The trees are built the same
// way a live observation is: accessibility nodes, then the semantic list, then the renderer.
import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticNodes, filterVisibleTextNodes } from "../dist/native-browser-observation.js";
import { changedIds, rememberNodes } from "../dist/observe/baseline.js";
import { renderState } from "../dist/observe/render.js";
import { buildSemanticTree } from "../dist/observe/tree.js";
import { renderCaptured } from "../dist/observe/view.js";

let seq = 0;
const URL = "https://example.com/orders";

function el(role, name, children = [], extra = {}) {
  const nodeId = `n${++seq}`;
  const self = {
    nodeId,
    backendDOMNodeId: extra.backend ?? 1000 + seq,
    role: { value: role },
    name: { value: name },
  };
  if (extra.value !== undefined) self.value = { value: extra.value };
  if (extra.properties) self.properties = extra.properties;
  if (extra.frameId) self.frameId = extra.frameId;
  const flat = [self];
  for (const subtree of children) {
    const [head, ...rest] = subtree;
    flat.push({ ...head, parentId: nodeId }, ...rest);
  }
  return flat;
}

function prop(name, value) {
  return { name, value: { value } };
}

function render(ax, options = {}) {
  const url = options.url ?? URL;
  const visible = options.text ?? ax.map((node) => node.name?.value).filter(Boolean).join("\n");
  const filtered = filterVisibleTextNodes(ax, visible);
  const semantic = createSemanticNodes(filtered, options.query ? { query: options.query } : {});
  const tree = buildSemanticTree({
    ax,
    shown: semantic.nodes,
    url,
    ...(options.title ? { title: options.title } : {}),
    ...(options.clickables ? { clickables: options.clickables } : {}),
    ...(options.offscreen ? { offscreen: options.offscreen } : {}),
  });
  const view = renderState(tree, {
    budget: options.budget ?? 8000,
    ...(options.query ? { focus: options.query } : {}),
    ...(options.delta ? { delta: options.delta } : {}),
    ...(options.expand ? { expand: options.expand } : {}),
  });
  return { view, nodes: semantic.nodes, url };
}

function legacy(url, nodes) {
  const lines = [url];
  const groups = new Map();
  for (const node of nodes) {
    if (["heading", "statictext", "paragraph"].includes(node.role.toLowerCase()) || node.value !== undefined)
      continue;
    const key = `${node.role}|${node.name}`;
    groups.set(key, [...(groups.get(key) ?? []), node.backendNodeId || node.ref]);
  }
  const repeats = new Map([...groups].filter(([, ids]) => ids.length > 4));
  const printed = new Set();
  for (const node of nodes) {
    const role = node.role.toLowerCase();
    if (role === "heading") {
      lines.push(`## ${node.name}`);
      continue;
    }
    if (role === "statictext" || role === "paragraph") {
      lines.push(node.name);
      continue;
    }
    let text = `[${node.backendNodeId}] ${node.role} ${JSON.stringify(node.name)}`;
    if (node.value !== undefined) text += ` = ${JSON.stringify(node.value)}`;
    for (const flag of ["disabled", "checked", "focused", "expanded", "selected", "pressed", "mixed"]) {
      if (node[flag] !== undefined) text += ` ${flag}=${node[flag]}`;
    }
    const group = repeats.get(`${node.role}|${node.name}`);
    if (group) {
      if (printed.has(group)) continue;
      printed.add(group);
      text = `[${group.join(",")}] ${node.role} ${JSON.stringify(node.name)} x${group.length}`;
    }
    lines.push(text);
  }
  return lines.join("\n");
}

function deals() {
  const rows = [1, 2, 3].map((n) =>
    el("row", "", [
      el("cell", `Deal ${n}`),
      el("cell", "40% off"),
      el("link", "View deal", [], { properties: [prop("url", `https://example.com/deals/${n}`)] }),
      el("button", "Save"),
    ]),
  );
  return el("RootWebArea", "Deals", [
    el("navigation", "Main", [el("link", "Today"), el("link", "Expired")]),
    el("main", "", [el("heading", "Today's deals"), el("table", "Deals", rows)]),
    el("contentinfo", "", [el("link", "About"), el("link", "Careers")]),
  ]);
}

function jobs() {
  const items = ["Designer", "Editor", "Producer"].map((title) =>
    el("listitem", "", [el("statictext", title), el("statictext", "Remote"), el("button", "Apply")]),
  );
  return el("RootWebArea", "Jobs", [el("main", "", [el("heading", "Open roles"), el("list", "Roles", items)])]);
}

function thread() {
  return el("RootWebArea", "Thread", [
    el("main", "", [el("heading", "Show your work"), el("button", "Like"), el("button", "Show more")]),
  ]);
}

function shop() {
  return el("RootWebArea", "Shop", [
    el("main", "", [
      el("heading", "Lamps"),
      el("link", "Brass lamp", [], { properties: [prop("url", "https://example.com/lamps/brass")] }),
      el("link", "Copper lamp", [], { properties: [prop("url", "https://example.com/lamps/copper")] }),
    ]),
  ]);
}

function orders() {
  const years = ["2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018"].map((year) =>
    el("option", year),
  );
  return el("RootWebArea", "Your Orders", [
    el("navigation", "Main", [el("link", "Home"), el("link", "Buy again")]),
    el("main", "", [
      el("heading", "Your Orders"),
      el("form", "Filter", [
        el("combobox", "Year", years, { value: "2026", backend: 301 }),
        el("button", "Apply", [], { backend: 305 }),
      ]),
      el("table", "Orders", [
        el("row", "", [
          el("cell", "1182"),
          el("cell", "USB cable"),
          el("cell", "Delivered"),
          el("link", "View", [], { backend: 412, properties: [prop("url", "https://example.com/orders/1182")] }),
          el("button", "Return", [], { backend: 413 }),
        ]),
        el("row", "", [
          el("cell", "1175"),
          el("cell", "HDMI cable"),
          el("link", "View", [], { backend: 414, properties: [prop("url", "https://example.com/orders/1175")] }),
        ]),
      ]),
    ]),
    el("dialog", "Cookie preferences", [el("button", "Reject all", [], { backend: 220 })]),
    el("contentinfo", "", [el("link", "Help"), el("link", "Returns")]),
  ]);
}

function login() {
  return el("RootWebArea", "Sign in", [
    el("main", "", [
      el("form", "Sign in", [
        el("textbox", "Email", [], { properties: [prop("focused", true)] }),
        el("textbox", "Password"),
        el("button", "Sign in"),
      ]),
    ]),
  ]);
}

function applyForm() {
  return el("RootWebArea", "Apply", [
    el("main", "", [
      el("form", "Application", [
        el("textbox", "", [], {
          backend: 9,
          properties: [
            prop("placeholder", "you@example.com"),
            prop("required", true),
            prop("invalid", true),
            prop("errormessage", "Enter an email"),
          ],
        }),
        el("button", "Submit"),
      ]),
    ]),
  ]);
}

function news() {
  return el("RootWebArea", "News", [
    el("main", "", [
      el("heading", "City desk"),
      el("link", "Read more", [], { properties: [prop("url", "https://example.com/news/city")] }),
      el("heading", "Markets"),
      el("button", "Save story"),
    ]),
  ]);
}

function directory() {
  const links = Array.from({ length: 30 }, (_, index) => el("link", `Secret ${index}`));
  return el("RootWebArea", "Directory", [
    el("navigation", "Main", links),
    el("main", "", [el("button", "Continue", [], { backend: 70 })]),
    el("contentinfo", "", [el("link", "Privacy")]),
  ]);
}

function cookies() {
  return el("RootWebArea", "Home", [
    el("main", "", [el("heading", "Welcome"), el("button", "Continue")]),
    el("dialog", "Cookie preferences", [el("button", "Reject all")]),
  ]);
}

function namedEdits() {
  const rows = Array.from({ length: 12 }, (_, index) =>
    el("row", "", [
      el("cell", `Order ${index + 1}`),
      el("cell", `Item ${index + 1}`),
      el("button", "Edit", [], { backend: 500 + index }),
    ]),
  );
  return el("RootWebArea", "Edits", [el("main", "", [el("table", "Edits", rows)])]);
}

function offscreen() {
  return el("RootWebArea", "Editor", [
    el("main", "", [el("button", "Save", [], { backend: 15 }), el("button", "Cancel")]),
  ]);
}

function search() {
  const items = ["Lamp", "Cable"].map((name) =>
    el("listitem", "", [el("statictext", name), el("link", "Open", [], { properties: [prop("url", "https://example.com/search/1")] })]),
  );
  return el("RootWebArea", "Search", [el("main", "", [el("list", "Results", items)])]);
}

function yearPage() {
  const years = ["2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018"].map((year) =>
    el("option", year),
  );
  return el("RootWebArea", "Filter", [
    el("main", "", [el("combobox", "Year", years, { value: "2026", backend: 301 }), el("button", "Apply")]),
  ]);
}

function badAx() {
  return el("RootWebArea", "Canvas", [el("main", "", [el("heading", "Map")])]) ;
}

const pages = [
  { name: "deals", ax: deals, need: ['button "Save"', 'link "View deal"', 'row "Deal 1 · 40% off"', "→ /deals/1"] },
  { name: "jobs", ax: jobs, need: ['item "Designer · Remote"', 'button "Apply"', "## Open roles"] },
  { name: "thread", ax: thread, need: ['button "Like"', 'button "Show more"'] },
  { name: "shop", ax: shop, need: ['link "Brass lamp"', "→ /lamps/brass", "## Lamps"] },
  { name: "orders", ax: orders, need: ['button "Reject all"', '[301] combobox "Year" = 2026 (2026, 2025, 2024, +6)', 'row "1182 · USB cable"', "→ /orders/1182", 'button "Return"'] },
  { name: "year", ax: yearPage, need: ['combobox "Year" = 2026 (2026, 2025, 2024, +6)', 'button "Apply"'] },
  { name: "cookies", ax: cookies, need: ['dialog "Cookie preferences"', 'button "Reject all"', 'button "Continue"'] },
  { name: "login", ax: login, need: ['textbox "Email"', "focused=true", 'button "Sign in"'] },
  { name: "apply", ax: applyForm, need: ['textbox "you@example.com"', "required", 'invalid: "Enter an email"', 'button "Submit"'] },
  { name: "news", ax: news, need: ["## City desk", 'link "Read more"', "→ /news/city", 'button "Save story"'] },
  { name: "directory", ax: directory, need: ['[70] button "Continue"', 'nav "Main" (30 links)'] },
  { name: "bad-ax", ax: badAx, need: ["Accessibility tree is almost empty. Use page.act or a screenshot."], clickables: [{ backendNodeId: 77, text: "Track shipment" }], extra: ['clickable "Track shipment"'] },
  { name: "edits", ax: namedEdits, need: ['[500] button "Edit"', '[511] button "Edit"', 'row "Order 1 · Item 1"', 'row "Order 12 · Item 12"'] },
  { name: "offscreen", ax: offscreen, need: ['button "Save"', "↓", 'button "Cancel"'], offscreen: ["button|Save"] },
  { name: "search", ax: search, need: ['item "Lamp"', 'link "Open"'], url: "https://example.com/search?q=lamp#results", title: "Search" },
];

test("fifteen saved trees keep their controls inside the 3000 character budget", () => {
  const rows = [];
  for (const page of pages) {
    seq = 0;
    const ax = page.ax();
    const full = render(ax, { budget: 30000, url: page.url, title: page.title, clickables: page.clickables, offscreen: page.offscreen });
    seq = 0;
    const fitted = render(ax, { budget: 3000, url: page.url, title: page.title, clickables: page.clickables, offscreen: page.offscreen });
    const old = legacy(full.url, full.nodes);
    for (const needle of [...page.need, ...(page.extra ?? [])]) {
      assert.ok(fitted.view.includes(needle), `${page.name} missing ${needle}\n${fitted.view}`);
    }
    rows.push({ page: page.name, old: old.length, next: full.view.length, at3000: fitted.view.length });
  }
  console.log("snapshot size, old formatter vs v2 (no trailing visible-text dump)");
  console.log("page        old   new   new@3000");
  for (const row of rows) {
    console.log(
      `${row.page.padEnd(10)} ${String(row.old).padStart(5)} ${String(row.next).padStart(5)} ${String(row.at3000).padStart(8)}`,
    );
  }
  assert.equal(rows.length, 15);
});

test("an orders page leads with the dialog, names the row, and keeps the link path", () => {
  seq = 0;
  const { view } = render(orders(), { url: "https://example.com/orders/?tab=open#top", title: "Your Orders" });
  assert.match(view, /^example\.com\/orders\?tab=open#top · Your Orders/);
  const dialogAt = view.search(/^dialog "Cookie preferences"/m);
  const navAt = view.search(/^nav "Main"/m);
  assert.ok(dialogAt !== -1 && navAt !== -1 && dialogAt < navAt, view);
  assert.match(view, /\[220\] button "Reject all"/);
  assert.match(view, /\[412\] link "View" → \/orders\/1182/);
  assert.match(view, /\[413\] button "Return"/);
  assert.match(view, /table "Orders" \(2 rows\)/);
  assert.match(view, /footer \(2 links\)/);
  assert.doesNotMatch(view, /option "2018"/);
  const collapsed = view;
  assert.doesNotMatch(collapsed, /link "Home"/);
  seq = 0;
  const open = render(orders(), { expand: ["nav", "footer"] }).view;
  assert.match(open, /link "Home"/);
  assert.match(open, /link "Help"/);
});

test("twelve named Edit buttons stay on their own rows", () => {
  seq = 0;
  const { view } = render(namedEdits());
  assert.equal(view.split('button "Edit"').length - 1, 12);
  assert.doesNotMatch(view, /x12/);
  assert.match(view, /\[500\] button "Edit"/);
  assert.match(view, /\[511\] button "Edit"/);
  assert.match(view, /row "Order 12 · Item 12"/);
});

test("twelve identical Edit buttons with no row text collapse", () => {
  seq = 0;
  const buttons = Array.from({ length: 12 }, (_, index) => el("button", "Edit", [], { backend: 800 + index }));
  const { view } = render(el("RootWebArea", "Bulk", [el("main", "", buttons)]));
  assert.match(view, /button "Edit" x12/);
  assert.equal(view.split("x12").length - 1, 1);
});

test("identical buttons collapse only when every row name matches", () => {
  seq = 0;
  const same = Array.from({ length: 5 }, (_, index) =>
    el("row", "", [el("cell", "Pending"), el("cell", "Box"), el("button", "Edit", [], { backend: 900 + index })]),
  );
  const collapsed = render(el("RootWebArea", "Queue", [el("main", "", [el("table", "Queue", same)])])).view;
  assert.match(collapsed, /x5/);
  seq = 0;
  const rows = Array.from({ length: 5 }, (_, index) =>
    el("row", "", [
      el("cell", index === 4 ? "Shipped" : "Pending"),
      el("cell", "Box"),
      el("button", "Edit", [], { backend: 900 + index }),
    ]),
  );
  const distinct = render(el("RootWebArea", "Queue", [el("main", "", [el("table", "Queue", rows)])])).view;
  assert.equal(distinct.split('button "Edit"').length - 1, 5);
  assert.doesNotMatch(distinct, /x5/);
  assert.match(distinct, /row "Shipped · Box"/);
});

test("a query keeps the matching control and its row", () => {
  seq = 0;
  const ax = el("RootWebArea", "Your Orders", [
    el("main", "", [
      el("table", "Orders", [
        el("row", "", [
          el("cell", "1182"),
          el("cell", "USB cable"),
          el("button", "Edit", [], { backend: 1 }),
          el("button", "Return", [], { backend: 2 }),
        ]),
      ]),
    ]),
  ]);
  const { view } = render(ax, { query: "return" });
  assert.match(view, /button "Return"/);
  assert.match(view, /row "1182 · USB cable"/);
  assert.doesNotMatch(view, /button "Edit"/);
});

test("delta marks a changed control and a quiet page hides the rest", () => {
  const key = "snapshot-v2-delta";
  seq = 0;
  const before = el("RootWebArea", "Cart", [el("main", "", [el("button", "Save", [], { backend: 50 })])]);
  const first = createSemanticNodes(before).nodes;
  assert.equal(changedIds(key, first, true), undefined);
  rememberNodes(key, first, true);
  const quiet = changedIds(key, first, true);
  assert.ok(quiet && quiet.size === 0);
  seq = 0;
  const hidden = render(before, { delta: quiet }).view;
  assert.match(hidden, /unchanged lines hidden; bu\.state\(\) shows the whole page/);
  assert.doesNotMatch(hidden, /button "Save"/);
  seq = 0;
  const after = el("RootWebArea", "Cart", [el("main", "", [el("button", "Saved", [], { backend: 50 })])]);
  const changed = changedIds(key, createSemanticNodes(after).nodes, true);
  assert.ok(changed?.has(50));
  seq = 0;
  const view = render(after, { delta: changed }).view;
  assert.match(view, /\* \[50\] button "Saved"/);
});

test("the budget drops text and spare rows before a control", () => {
  seq = 0;
  const essay = el("RootWebArea", "Notes", [
    el("main", "", [el("statictext", "word ".repeat(80).trim()), el("button", "Buy", [], { backend: 3 })]),
  ]);
  const short = render(essay, { budget: 180 }).view;
  assert.match(short, /\[3\] button "Buy"/);
  assert.doesNotMatch(short, /word word word/);
  assert.match(short, /\(\+1 text line; page\.state\(\{query\}\)\)/);
  seq = 0;
  const rows = Array.from({ length: 40 }, (_, index) =>
    el("row", "", [
      el("cell", `Order ${index + 1}`),
      el("cell", "Cable"),
      el("button", "View", [], { backend: 5000 + index }),
    ]),
  );
  const cut = render(el("RootWebArea", "Orders", [el("main", "", [el("table", "Orders", rows)])]), { budget: 700 }).view;
  assert.match(cut, /table "Orders" \(40 rows; \d+ shown\)/);
  assert.match(cut, /\(\+\d+ rows; page\.state\(\{query\}\) or page\.table\(\)\)/);
  assert.match(cut, /button "View"/);
  assert.ok((cut.match(/button "View"/g) ?? []).length < 40, cut);
});

test("nav stays one line until it is expanded, and a directory button survives", () => {
  seq = 0;
  const closed = render(directory(), { budget: 3000 }).view;
  assert.match(closed, /nav "Main" \(30 links\)/);
  assert.doesNotMatch(closed, /link "Secret 7"/);
  assert.match(closed, /\[70\] button "Continue"/);
  seq = 0;
  const open = render(directory(), { expand: ["all"], budget: 30000 }).view;
  assert.match(open, /link "Secret 7"/);
});

test("fields keep flags, a spaced value, a frame ref, and skip a foreign url", () => {
  seq = 0;
  const ax = el("RootWebArea", "Account", [
    el("main", "", [
      el("textbox", "Name", [], { value: "Ada Lovelace", properties: [prop("disabled", true)] }),
      el("checkbox", "Alerts", [], { properties: [prop("checked", true), prop("focused", true)] }),
      el("link", "Orders", [], { properties: [prop("url", "https://example.com/orders/9")] }),
      el("link", "Docs", [], { properties: [prop("url", "https://other.test/docs")] }),
      el("button", "Frame save", [], { backend: 4242, frameId: "child-frame" }),
    ]),
  ]);
  const { view } = render(ax);
  assert.match(view, /= "Ada Lovelace" disabled=true/);
  assert.match(view, /checked=true focused=true/);
  assert.match(view, /link "Orders" → \/orders\/9/);
  const docs = view.split("\n").find((line) => line.includes('link "Docs"'));
  assert.ok(docs && !docs.includes("→"), docs);
  assert.match(view, /\[f1:e\d+\] button "Frame save"/);
  assert.doesNotMatch(view, /\[4242\]/);
});

test("an unnamed single-child container folds, and a dialog does not", () => {
  seq = 0;
  const folded = render(el("RootWebArea", "Fold", [el("main", "", [el("button", "Only")])])).view;
  assert.doesNotMatch(folded, /^main$/m);
  assert.match(folded, /button "Only"/);
  seq = 0;
  const dialog = render(el("RootWebArea", "Ask", [el("dialog", "", [el("button", "OK")])])).view;
  assert.match(dialog, /^dialog$/m);
  assert.match(dialog, /button "OK"/);
});

test("a truncated observation points at page.state when the budget can hold the note", () => {
  seq = 0;
  const ax = el("RootWebArea", "Home", [el("main", "", [el("button", "Go")])]);
  const view = renderCaptured({
    ax,
    shown: createSemanticNodes(ax).nodes,
    url: URL,
    title: "Home",
    clickables: [],
    offscreen: [],
    truncated: true,
  });
  assert.match(view, /\[observation truncated; page\.state\(\{query\}\) for a focused look\]/);
});
