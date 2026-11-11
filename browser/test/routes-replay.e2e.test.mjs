// Reviewer-run. A fixture task recorded once, replayed with no model, then a ?layout=b page
// where the same CSS path points at a different control. Replay must stop before that step.
// This file does not launch Chrome; it drives the replay host against the two layouts.
import assert from "node:assert/strict";
import test from "node:test";
import { replay, replayRung } from "../packages/engine/dist/replay/index.js";

const recorded = {
  id: "orders",
  site: "shop.test",
  signature: ["orders"],
  inputs: [{ name: "year", example: "2024" }],
  steps: [
    {
      kind: "click",
      target: { role: "button", name: "Download", css: ".download", text: "Download" },
      onPageType: "orders",
      expectEffect: "confirmed",
    },
  ],
  reads: [],
  writes: false,
  okRuns: 2,
  lastOkAt: "2026-11-03T00:00:00.000Z",
  summary: "orders",
  cell: "await page.click()",
};

function page(layout) {
  const controls =
    layout === "b"
      ? [{ role: "button", name: "Export", css: ".download", text: "Export" }]
      : [{ role: "button", name: "Download", css: ".download", text: "Download" }];
  const acted = [];
  return {
    acted,
    host: {
      pageType: async () => "orders",
      state: async () => layout,
      controls: async () => controls,
      act: async (step) => {
        acted.push(step.target?.name);
        return {
          effect: "confirmed",
          output: { year: "2025" },
          event: {
            id: "1",
            cellId: "c",
            chatId: "chat",
            tabId: 1,
            at: 1,
            ms: 4,
            kind: "click",
            label: "Download",
            site: "shop.test",
            write: false,
          },
        };
      },
    },
  };
}

test(
  "the second run replays at rung 0 and layout=b stops before the wrong control",
  { skip: !process.env.REQUIRE_E2E },
  async () => {
    assert.equal(replayRung(recorded, { year: "2025" }), 0);
    const first = page("a");
    const again = await replay(recorded, { year: "2025" }, first.host);
    assert.equal(again.done, true);
    assert.deepEqual(first.acted, ["Download"]);
    const changed = page("b");
    const stopped = await replay(recorded, { year: "2025" }, changed.host);
    assert.equal(stopped.done, false);
    assert.equal(stopped.at, 0);
    assert.deepEqual(changed.acted, []);
  },
);
