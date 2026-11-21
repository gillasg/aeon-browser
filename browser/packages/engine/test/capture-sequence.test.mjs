import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserSurfaceApi } from "../dist/code-api-surface.js";

function load(page, calls = []) {
  const warnings = [];
  const context = vm.createContext({
    console: {
      warn: (line) => warnings.push(String(line)),
      log() {},
      error() {},
      info() {},
      debug() {},
    },
    page,
    sleep: async (ms) => {
      calls.push({ sleep: ms });
    },
    __call: async (request) => {
      calls.push(request);
      return {
        path: request.name.startsWith("/") ? request.name : `/session/screens/${request.name}`,
      };
    },
  });
  vm.runInContext(browserSurfaceApi, context);
  return { context, warnings };
}

function pageOf(events, frames) {
  let index = 0;
  return {
    evaluate: async () => ({ width: 1000, height: 800 }),
    cdp: async (method, params) => {
      events.push({ method, params });
      return {};
    },
    locator: (selector) => ({
      click: async () => {
        events.push({ click: selector });
      },
    }),
    clickAt: async (x, y) => {
      events.push({ clickAt: { x, y } });
    },
    screenshot: async (options) => {
      const data = frames[Math.min(index, frames.length - 1)];
      index += 1;
      events.push({ shot: options.path, data });
      return { saved: `/saved/${options.path}`, dataBase64: data };
    },
  };
}

test("captureSequence wheels at the viewport centre, waits, then saves each frame", async () => {
  const events = [];
  const sleeps = [];
  const { context } = load(pageOf(events, ["a", "b", "c"]), sleeps);
  const saved = await vm.runInContext(
    `(async () => __captureSequence({ steps: 3, path: "r0.png", waitMs: 1500 }))()`,
    context,
  );
  assert.equal(
    JSON.stringify(saved),
    JSON.stringify(["/saved/r0-0.png", "/saved/r0-1.png", "/saved/r0-2.png"]),
  );
  assert.equal(
    JSON.stringify(events.map((event) => event.method || event.shot)),
    JSON.stringify([
      "Input.dispatchMouseEvent",
      "r0-0.png",
      "Input.dispatchMouseEvent",
      "r0-1.png",
      "Input.dispatchMouseEvent",
      "r0-2.png",
    ]),
  );
  assert.equal(
    JSON.stringify(events[0].params),
    JSON.stringify({ type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 800 }),
  );
  assert.equal(
    JSON.stringify(sleeps),
    JSON.stringify([{ sleep: 1500 }, { sleep: 1500 }, { sleep: 1500 }]),
  );
});

test("captureSequence stops after two identical frames and can click instead of wheel", async () => {
  const events = [];
  const { context } = load(pageOf(events, ["same", "same", "later"]));
  const saved = await vm.runInContext(
    `(async () => __captureSequence({ steps: 5, waitMs: 0 }))()`,
    context,
  );
  assert.equal(
    JSON.stringify(saved),
    JSON.stringify(["/saved/sequence-0.png", "/saved/sequence-1.png"]),
  );
  assert.equal(events.filter((event) => event.shot).length, 2);

  const clicks = [];
  const clicked = load(pageOf(clicks, ["a", "b"]), []);
  await vm.runInContext(
    `(async () => __captureSequence({ steps: 1, click: "#next", waitMs: 0, stopWhenUnchanged: false }))()`,
    clicked.context,
  );
  assert.equal(JSON.stringify(clicks[0]), JSON.stringify({ click: "#next" }));
  assert.equal(
    clicks.some((event) => event.method),
    false,
  );

  const points = [];
  const pointed = load(pageOf(points, ["a"]), []);
  await vm.runInContext(
    `(async () => __captureSequence({ steps: 1, click: { x: 12, y: 40 }, waitMs: 0 }))()`,
    pointed.context,
  );
  assert.equal(JSON.stringify(points[0]), JSON.stringify({ clickAt: { x: 12, y: 40 } }));

  await assert.rejects(
    () =>
      vm.runInContext(
        `(async () => __captureSequence({ steps: 1, click: { x: 1 }, waitMs: 0 }))()`,
        load(pageOf([], ["a"])).context,
      ),
    /INVALID_INPUT: click is a CSS selector or \{x, y\}/,
  );
});

test("captureSequence caps steps at 30 and waitMs at 60s", async () => {
  const events = [];
  const sleeps = [];
  const frames = Array.from({ length: 40 }, (_, index) => `frame-${index}`);
  const { context } = load(pageOf(events, frames), sleeps);
  const saved = await vm.runInContext(
    `(async () => __captureSequence({ steps: 100, wheel: 200, waitMs: 999999, stopWhenUnchanged: false, path: "/tmp/x/full.png" }))()`,
    context,
  );
  assert.equal(saved.length, 30);
  assert.equal(saved[0], "/saved//tmp/x/full-0.png");
  assert.equal(saved[29], "/saved//tmp/x/full-29.png");
  assert.equal(events.filter((event) => event.shot).length, 30);
  assert.equal(events[0].params.deltaY, 200);
  assert.equal(sleeps.length, 30);
  assert.equal(sleeps[0].sleep, 60000);
});

test("a screenshot asks the host to save the given path and returns that absolute path", async () => {
  const calls = [];
  const { context, warnings } = load({}, calls);
  const saved = await vm.runInContext(
    `(async () => __savedShot({ data: "AAAA", mimeType: "image/png" }, { path: "r0.png" }))()`,
    context,
  );
  assert.equal(calls[0].workspace, "screenshot");
  assert.equal(calls[0].name, "r0.png");
  assert.equal(calls[0].base64, true);
  assert.equal(calls[0].value, "AAAA");
  assert.equal(saved.saved, "/session/screens/r0.png");
  assert.equal(Object.prototype.propertyIsEnumerable.call(saved, "dataBase64"), false);
  assert.equal(JSON.stringify(saved).includes("dataBase64"), false);
  assert.equal(saved.dataBase64, "AAAA");

  const absolute = await vm.runInContext(
    `(async () => __savedShot({ data: "BBBB", mimeType: "image/png" }, { path: "/tmp/x/full.png" }))()`,
    context,
  );
  assert.equal(calls[1].name, "/tmp/x/full.png");
  assert.equal(absolute.saved, "/tmp/x/full.png");

  context.__call = async (request) => {
    calls.push(request);
    return {
      path: "/session/screens/full.png",
      note: "saved in the session screens folder; /etc/full.png is outside the session folder and the temp directory",
    };
  };
  const warned = await vm.runInContext(
    `(async () => __savedShot({ data: "CCCC", mimeType: "image/png" }, { path: "/etc/full.png" }))()`,
    context,
  );
  assert.equal(warned.saved, "/session/screens/full.png");
  assert.match(warnings[0], /^\[warn\] saved in the session screens folder/);
});
