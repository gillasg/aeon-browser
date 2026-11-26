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

test("an intercepted HTML5 drag is replayed as dragEnter, dragOver, drop at the target", async () => {
  calls.length = 0;
  const listeners = new Set();
  globalThis.chrome.debugger.onEvent = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };
  const data = { items: [{ mimeType: "text/plain", data: "a" }], dragOperationsMask: 1 };
  globalThis.chrome.debugger.sendCommand = async (_d, method, params) => {
    calls.push({ method, params });
    if (
      method === "Input.dispatchMouseEvent" &&
      params.type === "mouseMoved" &&
      params.buttons === 1
    )
      for (const fn of listeners) fn({ tabId: 9 }, "Input.dragIntercepted", { data });
    return {};
  };
  try {
    const result = await dispatchPointer(
      { tabId: 9 },
      { op: "pointer", action: "drag", x: 10, y: 10, toX: 300, toY: 200 },
    );
    assert.deepEqual(result, { dragged: true, html5: true });
    const drags = calls.filter((c) => c.method === "Input.dispatchDragEvent").map((c) => c.params);
    assert.deepEqual(
      drags.map((d) => d.type),
      ["dragEnter", "dragOver", "drop"],
    );
    assert.deepEqual(drags[2].data, data);
    assert.deepEqual([drags[2].x, drags[2].y], [300, 200]);
    const intercept = calls.filter((c) => c.method === "Input.setInterceptDrags");
    assert.deepEqual(
      intercept.map((c) => c.params.enabled),
      [true, false],
    );
    assert.equal(listeners.size, 0);
  } finally {
    delete globalThis.chrome.debugger.onEvent;
  }
});

test("a pointer-only drag (nothing intercepted) finishes on the mouse path", async () => {
  calls.length = 0;
  globalThis.chrome.debugger.sendCommand = async (_d, method, params) => {
    calls.push({ method, params });
    return {};
  };
  const result = await dispatchPointer(
    { tabId: 9 },
    { op: "pointer", action: "drag", x: 10, y: 10, toX: 50, toY: 50 },
  );
  assert.deepEqual(result, { dragged: true, html5: false });
  assert.equal(calls.filter((c) => c.method === "Input.dispatchDragEvent").length, 0);
});
