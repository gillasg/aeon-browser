// The provider composer marker is temporary: any throw after it is set (a re-render, a
// navigation, a refused key) must still remove it, or the page keeps [data-graft-composer].
import assert from "node:assert/strict";
import test from "node:test";
import { uiScript } from "../dist/providers.js";

test("a throw after the composer is marked still removes the marker", async () => {
  const dom = fakeProviderPage();
  await assert.rejects(runCode(uiScript("chatgpt", "hello"), dom), /re-rendered/);
  assert.deepEqual(dom.marked(), [], "the composer marker survived a throw");
});

function runCode(code, dom) {
  return new Function("page", "document", "return " + code)(dom.page, dom.document);
}

/** Enough of a page for the provider script: one real composer and its buttons. */
function fakeProviderPage() {
  const composer = element("textarea");
  const send = element("button");
  const document = {
    querySelectorAll(selector) {
      if (selector === "[data-graft-composer]")
        return [composer].filter((node) => node.hasAttribute("data-graft-composer"));
      if (selector === "textarea") return [composer];
      if (selector === "button") return [send];
      return [];
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
  };
  const page = {
    evaluate: async (fn, arg) =>
      new Function("document", "arg", `return (${fn})(arg)`)(document, arg),
    waitForTimeout: async () => undefined,
    keyboard: async () => undefined,
    cdp: async () => undefined,
    locator: () => ({
      first: () => ({
        click: async () => {
          throw new Error("re-rendered");
        },
        press: async () => undefined,
        count: async () => 1,
      }),
    }),
  };
  return { page, document, marked: () => document.querySelectorAll("[data-graft-composer]") };
}

function element(tag) {
  const attributes = new Map();
  return {
    tagName: tag.toUpperCase(),
    value: "",
    innerText: "",
    getBoundingClientRect: () => ({ width: 320, height: 40 }),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    hasAttribute: (name) => attributes.has(name),
    removeAttribute: (name) => attributes.delete(name),
  };
}
