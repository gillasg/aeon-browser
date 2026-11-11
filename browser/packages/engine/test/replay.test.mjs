import assert from "node:assert/strict";
import test from "node:test";
import { matchControl, memoryLine, replay, replayRung, routeDraft } from "../dist/replay/index.js";

function event(label) {
  return {
    id: "s",
    cellId: "c",
    chatId: "chat",
    tabId: 1,
    at: 1,
    ms: 1,
    kind: "click",
    label,
    site: "shop.test",
    write: false,
  };
}

function route(overrides = {}) {
  return {
    id: "r",
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
    ...overrides,
  };
}

function host(controls, acted) {
  return {
    pageType: async () => "orders",
    state: async () => "on orders",
    controls: async () => controls,
    act: async () => {
      acted.push("acted");
      return { effect: "confirmed", output: { ok: true }, event: event("Download") };
    },
  };
}

test("replay stops before a changed control and never acts on the wrong one", async () => {
  const layoutA = [{ role: "button", name: "Download", css: ".download", text: "Download" }];
  const layoutB = [{ role: "button", name: "Export", css: ".download", text: "Export" }];
  assert.equal(matchControl(route().steps[0].target, layoutB), undefined);
  const acted = [];
  const stopped = await replay(route(), { year: "2024" }, host(layoutB, acted));
  assert.equal(stopped.done, false);
  assert.equal(stopped.at, 0);
  assert.equal(stopped.why, "target did not resolve");
  assert.deepEqual(stopped.steps, []);
  assert.equal(acted.length, 0);
  const ran = await replay(route(), { year: "2024" }, host(layoutA, acted));
  assert.equal(ran.done, true);
  assert.equal(acted.length, 1);
});

test("a page-type miss stops before the step", async () => {
  const acted = [];
  const page = host(
    [{ role: "button", name: "Download", css: ".download", text: "Download" }],
    acted,
  );
  page.pageType = async () => "checkout";
  const stopped = await replay(route(), { year: "2024" }, page);
  assert.equal(stopped.done, false);
  assert.match(stopped.why, /checkout/);
  assert.equal(acted.length, 0);
});

test("rung 0 needs an exact map, and writes need two successes", () => {
  const read = route();
  assert.equal(replayRung(read, { year: "2025" }), 0);
  assert.equal(replayRung(read, {}), 1);
  assert.equal(replayRung({ ...read, ambiguous: true }, { year: "2025" }), 1);
  assert.equal(replayRung({ ...read, writes: true, okRuns: 1 }, { year: "2025" }), 1);
  assert.equal(replayRung({ ...read, writes: true, okRuns: 2 }, { year: "2025" }), 0);
  assert.equal(memoryLine(read.lastOkAt), "via memory · run of 3 Nov");
  assert.equal(routeDraft(read, 0), undefined);
  assert.equal(routeDraft(read, 1).ranAt, read.lastOkAt);
});
