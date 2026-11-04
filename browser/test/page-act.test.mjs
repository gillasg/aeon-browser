import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserActApi } from "../packages/engine/dist/code-api-act.js";
import { createHostHandler } from "../packages/tools/dist/host.js";

// page.observe / page.act run in the cell against a fake page, with the real host handler (a fake
// model, a real action cache on disk). Proves: one model call per act, cached replays with no
// model call, self-healing when the page changed, a two-step act sees only what was added, and
// variable values never reach the model, the cache or the result.

function world({ nodes, onClick }) {
  const states = new Map();
  const done = [];
  let snapshots = 0;
  const state = () => ({
    url: "https://shop.test/p/1",
    documentEpoch: 1,
    snapshotId: "s" + ++snapshots,
    nodes: nodes(),
  });
  const page = {
    snapshot: async () => {
      const value = state();
      states.set("t", value);
      return value;
    },
    click: async (id) => {
      done.push(["click", id]);
      onClick?.(id);
    },
    fill: async (id, value) => done.push(["fill", id, value]),
    press: async (id, key) => done.push(["press", id, key]),
    hover: async (x, y) => done.push(["hover", x, y]),
    cdp: async () => ({ model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } }),
  };
  return { states, done, page };
}

async function cell(setup, model) {
  const seen = [];
  const home = await mkdtemp(join(tmpdir(), "page-act-"));
  const host = createHostHandler({
    dataDirectory: home,
    model: async () => ({
      complete: async (request) => {
        seen.push(request.messages[0].content[0].text);
        return {
          content: [{ type: "toolCall", id: "1", name: "choose", arguments: model(seen.length) }],
        };
      },
    }),
  });
  const { states, done, page } = world(setup);
  const logs = [];
  const make = new Function(
    "__states",
    "__key",
    "browser",
    "__call",
    "console",
    "__base",
    browserActApi + "\nreturn __extendPageAct('t', __base);",
  );
  const api = make(
    states,
    () => "t",
    { page: () => page },
    (request) => host(request, { source: "chat", scope: "c" }),
    { log: (line) => logs.push(line) },
    {
      markdown: async () => "# Nord 6\nPrice: ₹44,999\nDelivery by 8 Nov",
      url: async () => "https://shop.test/p/1",
      extract: async (spec) => ({ scripted: Boolean(spec.script) }),
    },
  );
  return { api, seen, done, logs, home };
}

const button = (id, name) => ({ backendNodeId: id, role: "button", name });

test("act: one model call, then the cache replays it with no model call", async () => {
  const run = await cell({ nodes: () => [button(5, "Add to cart"), button(6, "Buy now")] }, () => ({
    actions: [{ id: "5", method: "click", args: [], description: "Add to cart" }],
    twoStep: false,
  }));
  const first = await run.api.act("add it to the cart");
  assert.deepEqual(first, { ok: true, cached: false, steps: ["Add to cart"] });
  const again = await run.api.act("Add it to the  cart");
  assert.equal(again.cached, true);
  assert.equal(run.seen.length, 1, "the replay made no model call");
  assert.deepEqual(run.done, [
    ["click", 5],
    ["click", 5],
  ]);
});

test("a replay whose element is gone asks the model again and re-caches", async () => {
  let layout = 1;
  const run = await cell(
    {
      nodes: () =>
        layout === 1 ? [button(5, "Add to cart")] : [button(9, "Add to bag"), button(10, "Save")],
    },
    (call) => ({
      actions: [
        call === 1
          ? { id: "5", method: "click", args: [], description: "Add to cart" }
          : { id: "9", method: "click", args: [], description: "Add to bag" },
      ],
      twoStep: false,
    }),
  );
  await run.api.act("add it to the cart");
  layout = 2;
  const healed = await run.api.act("add it to the cart");
  assert.equal(healed.cached, false);
  assert.equal(run.seen.length, 2);
  const cache = JSON.parse(await readFile(join(run.home, "action-cache.json"), "utf8"));
  assert.equal(Object.values(cache)[0].steps[0].name, "Add to bag");
});

test("a two-step act shows the model only what the first step added", async () => {
  let open = false;
  const run = await cell(
    {
      nodes: () => [
        button(5, "Size"),
        button(6, "Checkout"),
        ...(open
          ? [
              { backendNodeId: 7, role: "option", name: "Small" },
              { backendNodeId: 8, role: "option", name: "Large" },
            ]
          : []),
      ],
      onClick: (id) => {
        if (id === 5) open = true;
      },
    },
    (call) =>
      call === 1
        ? {
            actions: [{ id: "5", method: "click", args: [], description: "Size menu" }],
            twoStep: true,
          }
        : {
            actions: [{ id: "8", method: "click", args: [], description: "Large" }],
            twoStep: false,
          },
  );
  const result = await run.api.act("choose size Large");
  assert.deepEqual(result.steps, ["Size menu", "Large"]);
  assert.match(run.seen[1], /\[8\] option "Large"/);
  assert.doesNotMatch(run.seen[1], /Checkout/, "the second look holds only the new elements");
});

test("variables reach the page only: never the model, the cache or the result", async () => {
  const run = await cell(
    { nodes: () => [{ backendNodeId: 3, role: "textbox", name: "Email" }] },
    () => ({
      actions: [{ id: "3", method: "fill", args: ["%email%"], description: "Email" }],
      twoStep: false,
    }),
  );
  const result = await run.api.act("type my email", { variables: { email: "me@private.test" } });
  assert.deepEqual(run.done, [["fill", 3, "me@private.test"]]);
  assert.doesNotMatch(run.seen.join(" ") + JSON.stringify(result) + run.logs.join(" "), /private/);
  assert.doesNotMatch(await readFile(join(run.home, "action-cache.json"), "utf8"), /private/);
  await assert.rejects(
    run.api.act({ id: "3", method: "fill", args: ["%other%"] }),
    /INVALID_VARIABLE/,
  );
});

test("observe returns replayable actions; act(action) runs one with no model call", async () => {
  const run = await cell({ nodes: () => [button(5, "Next"), button(6, "Back")] }, () => ({
    actions: [
      { id: "5", method: "click", args: [], description: "Next" },
      { id: "99", method: "click", args: [], description: "not on the page" },
      { id: "6", method: "hover", args: [], description: "Back" },
    ],
    twoStep: false,
  }));
  const actions = await run.api.observe("the paging buttons", { limit: 5 });
  assert.deepEqual(
    actions.map((item) => [item.id, item.role, item.name, item.method]),
    [
      ["5", "button", "Next", "click"],
      ["6", "button", "Back", "hover"],
    ],
  );
  await run.api.act(actions[1]);
  assert.equal(run.seen.length, 1);
  assert.deepEqual(run.done, [["hover", 5, 5]]);
});

test("nothing that fits is a named error, not a guess", async () => {
  const run = await cell({ nodes: () => [button(5, "Next")] }, () => ({
    actions: [],
    twoStep: false,
  }));
  await assert.rejects(run.api.act("delete my account"), /ACT_NOT_FOUND/);
});

test("page.extract(instruction) asks the fast model about the page; the script form is unchanged", async () => {
  const run = await cell({ nodes: () => [] }, () => ({}));
  const seen = [];
  const home = await mkdtemp(join(tmpdir(), "page-act-"));
  const host = createHostHandler({
    dataDirectory: home,
    model: async () => ({
      complete: async (request) => {
        seen.push(request);
        return {
          content: [
            {
              type: "toolCall",
              id: "1",
              name: "answer",
              arguments: { price: 44999, delivery: "8 Nov" },
            },
          ],
        };
      },
    }),
  });
  const schema = {
    type: "object",
    properties: { price: { type: "number" }, delivery: { type: "string" } },
  };
  const answer = await host(
    {
      pageExtract: { instruction: "price and delivery", schema, page: "Price: ₹44,999", url: "u" },
    },
    { source: "chat", scope: "c" },
  );
  assert.deepEqual(answer, { price: 44999, delivery: "8 Nov" });
  assert.equal(seen[0].tools[0].parameters, schema);
  assert.deepEqual(await run.api.extract({ script: "x" }), { scripted: true });
});
