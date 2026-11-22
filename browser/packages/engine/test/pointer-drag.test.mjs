import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_debuggee, method, params) => {
      calls.push({ method, params });
      return {};
    },
  },
};
const { dragPath, setHumanInputTiming } = await import("../dist/native-browser-human-input.js");
const { dispatchPointer } = await import("../dist/native-browser-pointer.js");

test("a drag path is curved, jittered and lands exactly on the target", () => {
  let seed = 7;
  setHumanInputTiming({ random: () => (seed = (seed * 16807) % 2147483647) / 2147483647 });
  try {
    const path = dragPath({ x: 100, y: 100 }, { x: 500, y: 100 });
    assert.ok(path.length >= 8);
    assert.deepEqual(path.at(-1), { x: 500, y: 100 });
    assert.ok(
      path.some((p) => Math.abs(p.y - 100) > 2),
      "path bows off the straight line",
    );
    for (let i = 1; i < path.length; i++)
      assert.ok(path[i].x >= path[i - 1].x - 2, "moves forward");
  } finally {
    setHumanInputTiming();
  }
});

test("drag sends move, press, buttons-held moves along the path, then release on the target", async () => {
  calls.length = 0;
  await dispatchPointer(
    { tabId: 9 },
    { op: "pointer", action: "drag", x: 10, y: 10, toX: 300, toY: 200 },
  );
  const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
  assert.equal(mouse[0].type, "mouseMoved");
  assert.equal(mouse[1].type, "mousePressed");
  const moves = mouse.slice(2, -1);
  assert.ok(moves.length >= 8);
  assert.ok(moves.every((m) => m.type === "mouseMoved" && m.buttons === 1));
  const last = mouse.at(-1);
  assert.equal(last.type, "mouseReleased");
  assert.deepEqual([last.x, last.y], [300, 200]);
});

test("a click is hover move, then press, then release, in W3C order", async () => {
  calls.length = 0;
  await dispatchPointer({ tabId: 9 }, { op: "pointer", action: "click", x: 40, y: 50 });
  const types = calls
    .filter((c) => c.method === "Input.dispatchMouseEvent")
    .map((c) => c.params.type);
  assert.deepEqual(types, ["mouseMoved", "mousePressed", "mouseReleased"]);
});
