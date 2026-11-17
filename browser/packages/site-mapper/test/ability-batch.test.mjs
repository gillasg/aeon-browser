// A read ability can take many inputs in one call; each item keeps its own result or error and the
// whole run is capped. Writes stay one per call (enforced in the tool's ability action).
import assert from "node:assert/strict";
import test from "node:test";
import { runBatched } from "../dist/tool.js";

test("batch inputs return one ok/result or error per input, in order", async () => {
  const seen = [];
  const answer = await runBatched([{ id: 1 }, { id: 2 }, { id: 3 }], async (inputs) => {
    seen.push(inputs.id);
    if (inputs.id === 2) throw new Error("no such record");
    return { title: `item ${inputs.id}` };
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(
    answer.items.map((item) => item.ok),
    [true, false, true],
  );
  assert.deepEqual(answer.items[0], { input: { id: 1 }, ok: true, result: { title: "item 1" } });
  assert.equal(answer.items[1].error, "no such record");
  assert.equal(answer.items[1].result, undefined);
  assert.deepEqual(answer.items[2].result, { title: "item 3" });
});

test("batch inputs are capped", async () => {
  let ran = 0;
  const inputs = Array.from({ length: 30 }, (_, index) => ({ id: index }));
  const answer = await runBatched(inputs, async () => ({ ran: ++ran }), 20);
  assert.equal(answer.items.length, 20);
  assert.equal(ran, 20);
});
