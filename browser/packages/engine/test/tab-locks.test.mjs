import assert from "node:assert/strict";
import test from "node:test";
import {
  lockedStep,
  normalOrigins,
  originAllowed,
  originRules,
} from "../dist/native-browser-tab-locks.js";

const target = { clientInstanceId: "c", tabId: 1, documentEpoch: 1 };
const readOnly = { readOnly: true };

test("a read-only tab blocks every page write and allows reads and navigation", () => {
  for (const step of [
    { op: "click", target },
    { op: "fill", target },
    { op: "press", target },
    { op: "keys", target },
    { op: "pointer", target },
    { op: "upload", target },
    { op: "paste", target },
    { op: "dialog", target },
    { op: "frames", action: "click", target },
    { op: "cdp", method: "Input.dispatchMouseEvent", target },
  ])
    assert.match(lockedStep(step, readOnly) ?? "", /^TAB_READ_ONLY/, step.op);
  for (const step of [
    { op: "observe", target },
    { op: "read", target },
    { op: "navigate", url: "https://a.test/", target },
    { op: "scroll", target },
    { op: "cdp", method: "Page.captureScreenshot", target },
    { op: "frames", action: "list", target },
  ])
    assert.equal(lockedStep(step, readOnly), undefined, step.op);
  assert.equal(lockedStep({ op: "click", target }, undefined), undefined);
});

test("allowed origins block navigation elsewhere, by origin not prefix", () => {
  const locks = {
    allowedOrigins: normalOrigins(["https://shop.test/cart", "http://127.0.0.1:8080"]),
  };
  assert.deepEqual(locks.allowedOrigins, ["https://shop.test", "http://127.0.0.1:8080"]);
  assert.equal(
    lockedStep({ op: "navigate", url: "https://shop.test/x", target }, locks),
    undefined,
  );
  assert.match(
    lockedStep({ op: "navigate", url: "https://shop.test.evil.test/", target }, locks) ?? "",
    /^TAB_ORIGIN_BLOCKED/,
  );
  assert.match(
    lockedStep({ op: "navigate", url: "http://shop.test/", target }, locks) ?? "",
    /^TAB_ORIGIN_BLOCKED/,
  );
  assert.equal(lockedStep({ op: "click", target }, locks), undefined);
  assert.equal(originAllowed("about:blank", locks.allowedOrigins), true);
  assert.equal(originAllowed("not a url", locks.allowedOrigins), false);
  assert.deepEqual(normalOrigins(["javascript:alert(1)", "file:///etc"]), []);
});

test("origin rules block the tab's top-level loads and allow each origin above that", () => {
  const rules = originRules(5, ["https://shop.test", "http://127.0.0.1:8080"]);
  assert.equal(rules.length, 3);
  const [block, ...allow] = rules;
  assert.equal(block.action.type, "block");
  assert.deepEqual(block.condition.tabIds, [5]);
  assert.deepEqual(block.condition.resourceTypes, ["main_frame"]);
  assert.deepEqual(
    allow.map((rule) => [rule.action.type, rule.condition.urlFilter]),
    [
      ["allow", "|https://shop.test/"],
      ["allow", "|http://127.0.0.1:8080/"],
    ],
  );
  assert.ok(allow.every((rule) => rule.priority > block.priority));
  assert.equal(new Set(rules.map((rule) => rule.id)).size, 3);
});
