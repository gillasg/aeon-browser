import assert from "node:assert/strict";
import test from "node:test";
import { formatCell } from "../dist/cell-grammar.js";

const now = new Date("2026-11-10T09:02:00.000Z");

function step(index, op) {
  return { index, action: { op, url: "https://shop.example/orders" }, disposition: "completed" };
}

test("a long cell that fails lists the steps that ran", () => {
  const steps = [0, 1, 2, 3, 4].map((index) => step(index, index === 4 ? "click" : "scroll"));
  steps[4].disposition = "failed";
  steps[4].code = "TARGET_HIDDEN";
  const text = formatCell(
    { steps, output: "", error: "TARGET_HIDDEN", startedAt: now.getTime() - 1500 },
    now,
  );
  assert.match(text, /\[ran\] 1 scroll/);
  assert.match(text, /\[ran\] 5 click/);
  assert.match(text, /error: TARGET_HIDDEN/);
  assert.match(text, /\[now\] .* · cell 1\.5 s · tabs 0\/8/);
});

test("a read's contradiction, partial list and location are in the cell", () => {
  const text = formatCell(
    {
      steps: [],
      output: "",
      value: {
        contradiction: 'contradiction: "page says 9, list has 0"',
        location: "Mumbai 400001",
        list: { count: 20, total: 143, partial: true },
      },
    },
    now,
  );
  assert.match(text, /contradiction: "page says 9, list has 0"/);
  assert.match(text, /location: Mumbai 400001/);
  assert.match(text, /list: 20 of 143 \(partial\)/);
});

test("five identical reads collapse to one line, and internal CDP stays off it", () => {
  const read = {
    action: { op: "observe", url: "https://razorpay.typeform.com/to/Aj64eENJ" },
    event: {
      id: "c:0",
      cellId: "11111111-1111-4111-8111-111111111111",
      chatId: "22222222-2222-4222-8222-222222222222",
      tabId: 7,
      at: 100,
      ms: 20,
      kind: "read",
      label: "Read razorpay.typeform.com",
      site: "razorpay.typeform.com",
      effect: "unverifiable",
      write: false,
    },
  };
  const text = formatCell(
    {
      steps: [
        read,
        read,
        read,
        read,
        read,
        {
          internal: true,
          action: { op: "cdp", method: "Page.getFrameTree", target: { tabId: 7 } },
        },
        {
          internal: true,
          action: { op: "cdp", method: "Page.createIsolatedWorld", target: { tabId: 7 } },
        },
        { action: { op: "cdp", method: "Page.getFrameTree", target: { tabId: 7 } } },
      ],
      output: "",
    },
    now,
  );
  assert.equal(text.split("Read razorpay.typeform.com").length - 1, 1);
  assert.match(text, /Read razorpay\.typeform\.com → unverifiable ×5/);
  assert.doesNotMatch(text, /createIsolatedWorld/);
  assert.match(text, /\[did\] cdp tab 7 Page\.getFrameTree/);
});

test("a confirmed click does not grow a next line", () => {
  const text = formatCell(
    {
      steps: [
        {
          action: { op: "click" },
          disposition: "completed",
          result: { effect: "confirmed", next: "page.snapshot()" },
        },
      ],
      output: "",
    },
    now,
  );
  assert.match(text, /\[did\] click/);
  assert.doesNotMatch(text, /\[next\]/);
});
