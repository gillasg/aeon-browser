import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { PICK_DESCRIBE_SOURCE } from "../dist/pick-describe-source.js";

function load(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const make = new Function(
    "document",
    `${PICK_DESCRIBE_SOURCE}; return { describe: __pickDescribe, escape: __pickEscape };`,
  );
  return { document, ...make(document) };
}

function only(document, selector, element) {
  const found = document.querySelectorAll(selector);
  assert.equal(found.length, 1, selector);
  assert.equal(found[0], element, selector);
}

test("a stable id wins, with special characters escaped", () => {
  const { document, describe } = load(`<div id="a:b.c[1]">x</div><div id="plain">y</div>`);
  const tricky = document.getElementById("a:b.c[1]");
  const picked = describe(tricky);
  assert.equal(picked.selector, "#a\\:b\\.c\\[1\\]");
  only(document, picked.selector, tricky);
  assert.equal(describe(document.getElementById("plain")).selector, "#plain");
});

test("generated ids are skipped for a test id, name or aria-label", () => {
  const { document, describe } = load(`
    <button id=":r3:" data-testid="buy">Buy</button>
    <input id="ember1234" name="email">
    <a href="/x" id="a1b2c3d4e5f6" aria-label='Open "cart"'>Cart</a>`);
  const [button] = document.querySelectorAll("button");
  assert.equal(describe(button).selector, '[data-testid="buy"]');
  const input = document.querySelector("input");
  assert.equal(describe(input).selector, 'input[name="email"]');
  const link = document.querySelector("a");
  const picked = describe(link);
  assert.match(picked.selector, /^a\[aria-label=/);
  only(document, picked.selector, link);
  assert.equal(picked.role, "link");
  assert.equal(picked.name, 'Open "cart"');
});

test("duplicate classes fall back to a unique structural path", () => {
  const { document, describe } = load(`
    <ul class="list"><li class="item">One</li><li class="item">Two</li><li class="item">Three</li></ul>
    <ul class="list"><li class="item">Four</li><li class="item">Five</li></ul>`);
  const items = document.querySelectorAll("li");
  const seen = new Set();
  for (const item of items) {
    const { selector } = describe(item);
    only(document, selector, item);
    seen.add(selector);
  }
  assert.equal(seen.size, items.length);
});

test("deep nesting anchors at the nearest stable id", () => {
  const { document, describe } = load(`
    <section id="results"><div><div><div><span>a</span><span>b</span></div></div></div></section>
    <div><div><div><span>a</span><span>b</span></div></div></div>`);
  const target = document.querySelector("#results span:nth-of-type(2)");
  const { selector } = describe(target);
  only(document, selector, target);
  assert.match(selector, /^#results > /);
});

test("form controls and SVG elements get roles, names and unique selectors", () => {
  const { document, describe } = load(`
    <form><label for="qty">Quantity</label><input id="qty" type="number">
    <label><input type="checkbox"> Gift wrap</label><input type="checkbox">
    <select aria-label="Size"><option>S</option></select>
    <input type="submit" value="Order"></form>
    <svg><g><circle r="1"></circle><circle r="2"></circle></g></svg>`);
  const qty = describe(document.getElementById("qty"));
  assert.deepEqual(
    [qty.selector, qty.role, qty.name, qty.tag],
    ["#qty", "spinbutton", "Quantity", "input"],
  );
  const boxes = document.querySelectorAll('input[type="checkbox"]');
  const gift = describe(boxes[0]);
  assert.equal(gift.role, "checkbox");
  assert.equal(gift.name, "Gift wrap");
  only(document, gift.selector, boxes[0]);
  only(document, describe(boxes[1]).selector, boxes[1]);
  const select = describe(document.querySelector("select"));
  assert.deepEqual([select.role, select.name], ["combobox", "Size"]);
  const submit = describe(document.querySelector('input[type="submit"]'));
  assert.deepEqual([submit.role, submit.name], ["button", "Order"]);
  const circle = document.querySelectorAll("circle")[1];
  only(document, describe(circle).selector, circle);
});

test("escape handles leading digits, a lone dash and control characters", () => {
  const { escape } = load("");
  assert.equal(escape("1a"), "\\31 a");
  assert.equal(escape("-"), "\\-");
  assert.equal(escape("-2x"), "-\\32 x");
  assert.equal(escape("a b"), "a\\ b");
  assert.equal(escape("a\u0001"), "a\\1 ");
});
