import assert from "node:assert/strict";
import test from "node:test";
import { submitToPi } from "../dist/session-controls.js";

const CELL = "await page.read()";

test("a submit sends one hidden message and its draft line contains the cell", async () => {
  const custom = [];
  const prompts = [];
  const session = {
    subscribe() {},
    async sendCustomMessage(message) {
      custom.push(message);
    },
    async prompt(text) {
      prompts.push(text);
    },
  };
  await submitToPi(session, {
    text: "show my orders",
    browserContext: {
      contextId: "11111111-1111-4111-8111-111111111111",
      kind: "page",
      capturedAt: "2026-11-10T09:02:00.000Z",
      target: {
        clientInstanceId: "22222222-2222-4222-8222-222222222222",
        browserRunId: "33333333-3333-4333-8333-333333333333",
        tabId: 1,
        tabIncarnation: "44444444-4444-4444-8444-444444444444",
      },
      url: "https://shop.example/orders",
      title: "Orders",
    },
    routeDraft: {
      site: "shop.example",
      summary: "open orders",
      cell: CELL,
      ranAt: "2026-11-03T00:00:00.000Z",
    },
  });
  assert.equal(custom.length, 1);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], "show my orders");
  assert.equal(custom[0].display, false);
  assert.match(
    custom[0].content,
    /\[draft\] shop\.example: open orders \(2026-11-03T00:00:00\.000Z\) await page\.read\(\)/,
  );
  assert.match(custom[0].content, /Untrusted browser context/);
  assert.equal(custom[0].content.includes("show my orders"), false);
});
