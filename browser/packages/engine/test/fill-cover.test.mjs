// fill: a covered text field fails fast with what covers it; {force: true} and <select> skip the
// hit-test; a missing target is held until the step's one deadline, not a fixed 3 s.
import assert from "node:assert/strict";
import test from "node:test";

let page = {};
globalThis.chrome = {
  debugger: {
    sendCommand: async (_source, method, params) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "o1" } };
      if (method === "Runtime.callFunctionOn") {
        const fn = String(params.functionDeclaration ?? "");
        if (/^function nodeState|nodeState\(/.test(fn)) return { result: { value: page.state } };
        if (/^function hitPoint|hitPoint\(/.test(fn)) return { result: { value: page.hit } };
        if (/coveringElement/.test(fn)) return { result: { value: page.cover } };
        return { result: { value: undefined } };
      }
      return {};
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: { get: async () => ({}), onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, id: "x" },
};

const input = await import("../dist/native-browser-input.js");

const textField = { visible: true, enabled: true, editable: true, file: false, textEntry: true };
const covered = { x: 150, y: 20, hit: false };
const cover =
  'covered by dialog "Cookie settings"; act inside it (bu.state() shows its ids) or close it first';

test("a covered text field throws TARGET_BLOCKED naming the cover", async () => {
  page = { state: textField, hit: covered, cover };
  await assert.rejects(input.actionablePoint({ tabId: 1 }, 5, true), (error) => {
    assert.equal(error.message, "TARGET_BLOCKED");
    assert.equal(
      error.detail,
      `Can't reach the field: covered by dialog "Cookie settings". Close it first, or pass {force: true}.`,
    );
    return true;
  });
});

test("force skips the cover check but keeps visible/enabled/editable", async () => {
  page = { state: textField, hit: covered, cover };
  assert.deepEqual(await input.actionablePoint({ tabId: 1 }, 5, true, true), { x: 150, y: 20 });
  page = { state: { ...textField, enabled: false }, hit: covered, cover };
  await assert.rejects(input.actionablePoint({ tabId: 1 }, 5, true, true), /TARGET_DISABLED/);
});

test("a <select> under a cover is still a value set", async () => {
  page = { state: { ...textField, textEntry: false }, hit: covered, cover };
  assert.deepEqual(await input.actionablePoint({ tabId: 1 }, 5, true), { x: 150, y: 20 });
});

test("a missing target is held until the deadline, not a fixed 3 s", async () => {
  const missing = new Error("TARGET_NOT_FOUND");
  const busy = async () => ({ active: true, changes: 1 });
  const started = Date.now();
  const clock = { deadline: started + 300, quietSince: started, seen: undefined };
  let holds = 0;
  await assert.rejects(async () => {
    while (await input.holdMissingTarget({ tabId: 1 }, missing, clock, busy)) holds += 1;
  }, /TARGET_NOT_FOUND/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 280 && elapsed < 1000, `stopped at the deadline: ${elapsed} ms`);
  assert.ok(holds > 1);
  const long = { deadline: Date.now() + 4_000, quietSince: Date.now(), seen: undefined };
  const t0 = Date.now();
  await assert.rejects(async () => {
    while (
      await input.holdMissingTarget({ tabId: 1 }, missing, long, async () => ({
        active: Date.now() - t0 < 3_300,
        changes: 1,
      }))
    );
  });
  assert.ok(Date.now() - t0 >= 3_200, "a later deadline holds past the old 3 s cap");
});

test("only a stale ref raised before any insert is replayable", async () => {
  const dom = await import("../dist/native-browser-dom.js");
  assert.equal(dom.isStaleBeforeInsert(dom.staleBeforeInsert()), true);
  assert.equal(dom.isStaleBeforeInsert(new Error("STALE_REF")), false);
  assert.equal(input.DEFAULT_STEP_MS, 5000);
});
