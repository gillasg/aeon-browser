import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

// The extension keeps a chat tab per eval task open for a long time, and the side panel stays
// mounted when closed. A continuous visual that ignores visibility pins a core and spins the GPU.
// This invariant fails if a hidden page schedules frames or timers after it is hidden.

async function loadVisibleWork() {
  const directory = await mkdtemp(join(tmpdir(), "aeon-visible-work-"));
  const outfile = join(directory, "visible-work.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("../../../packages/ui/src/visible-work.ts", import.meta.url)),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

const { runVisibleFrames, runVisibleInterval } = await loadVisibleWork();

/** A DOM tiny enough to prove the contract: visibility callbacks, rAF and intervals are counted. */
function harness(hidden = false) {
  const state = {
    hidden,
    listeners: new Map(),
    frames: [],
    scheduled: 0,
    cancelled: 0,
    intervals: [],
    cleared: 0,
    observed: null,
    disconnected: false,
  };
  globalThis.document = {
    get hidden() {
      return state.hidden;
    },
    addEventListener(name, fn) {
      const list = state.listeners.get(name) ?? [];
      list.push(fn);
      state.listeners.set(name, list);
    },
    removeEventListener(name, fn) {
      const list = (state.listeners.get(name) ?? []).filter((f) => f !== fn);
      state.listeners.set(name, list);
    },
  };
  globalThis.requestAnimationFrame = (fn) => {
    state.scheduled++;
    state.frames.push(fn);
    return state.frames.length;
  };
  globalThis.cancelAnimationFrame = () => {
    state.cancelled++;
  };
  globalThis.IntersectionObserver = class {
    constructor(cb) {
      state.observed = cb;
    }
    observe() {}
    disconnect() {
      state.disconnected = true;
    }
  };
  state.realSetInterval = globalThis.setInterval;
  state.realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    state.intervals.push({ fn, ms });
    return state.intervals.length;
  };
  globalThis.clearInterval = () => {
    state.cleared++;
  };
  return state;
}

const restore = (s) => {
  globalThis.setInterval = s.realSetInterval;
  globalThis.clearInterval = s.realClearInterval;
};
const fire = (s, name) => {
  for (const fn of s.listeners.get(name) ?? []) fn();
};
const stepFrame = (s, time) => {
  const fn = s.frames.pop();
  if (fn) fn(time);
};

function withHarness(state, fn) {
  try {
    return fn();
  } finally {
    restore(state);
  }
}

test("a hidden page schedules no frames and no polling timer", () => {
  const state = harness(true);
  withHarness(state, () => {
    let draws = 0;
    const stopFrames = runVisibleFrames({ nodeType: 1 }, () => draws++, 20);
    const stopTimer = runVisibleInterval(() => draws++, 1000);
    assert.equal(state.scheduled, 0, "no animation frame while hidden");
    assert.equal(state.intervals.length, 0, "no interval while hidden");
    assert.equal(draws, 0);
    stopFrames();
    stopTimer();
    assert.equal(state.disconnected, true);
  });
});

test("hiding a running page cancels its frames and timers and schedules no more", () => {
  const state = harness(false);
  withHarness(state, () => {
    let draws = 0;
    const stopFrames = runVisibleFrames({ nodeType: 1 }, () => draws++, 60);
    const stopTimer = runVisibleInterval(() => draws++, 1000);
    assert.equal(state.scheduled, 1, "one frame pending while visible");
    assert.equal(state.intervals.length, 1, "one timer while visible");
    stepFrame(state, 1000);
    assert.equal(draws, 1);

    state.hidden = true;
    fire(state, "visibilitychange");
    assert.ok(state.cancelled >= 1, "pending frame cancelled on hide");
    assert.equal(state.cleared, 1, "interval cleared on hide");
    const before = state.scheduled;
    stepFrame(state, 1016); // a stale callback must not restart the loop
    assert.equal(state.scheduled, before, "no frame scheduled after hiding");
    assert.equal(draws, 1, "no draw after hiding");

    state.hidden = false;
    fire(state, "visibilitychange");
    assert.equal(state.scheduled, before + 1, "loop resumes only when visible again");
    stopFrames();
    stopTimer();
  });
});

test("an off-screen element stops the loop even while the page is visible", () => {
  const state = harness(false);
  withHarness(state, () => {
    const stop = runVisibleFrames({ nodeType: 1 }, () => {}, 20);
    assert.equal(state.scheduled, 1);
    state.observed([{ isIntersecting: false }]);
    assert.ok(state.cancelled >= 1, "off-screen pauses the loop");
    const before = state.scheduled;
    stepFrame(state, 50);
    assert.equal(state.scheduled, before, "no frame scheduled while off-screen");
    state.observed([{ isIntersecting: true }]);
    assert.equal(state.scheduled, before + 1, "loop resumes when back on screen");
    stop();
  });
});

test("the frame cap draws far fewer times than the display refresh", () => {
  const state = harness(false);
  withHarness(state, () => {
    let draws = 0;
    const stop = runVisibleFrames({ nodeType: 1 }, () => draws++, 20);
    for (let time = 0; time < 200; time += 16) stepFrame(state, time);
    assert.ok(draws <= 5, `20 fps cap over 200ms, got ${draws} draws`);
    assert.ok(draws >= 4, `cap must still animate, got ${draws} draws`);
    stop();
  });
});

test("every continuous visual routes through the visibility gate", async () => {
  const ui = fileURLToPath(new URL("../../../packages/ui/src/", import.meta.url));
  const ext = fileURLToPath(new URL("../src/", import.meta.url));
  const [swarm, lattice, pending, activity, turn, orb] = await Promise.all([
    readFile(join(ui, "mini-swarm.tsx"), "utf8"),
    readFile(join(ui, "lattice-mark.tsx"), "utf8"),
    readFile(join(ui, "pending-work.tsx"), "utf8"),
    readFile(join(ui, "chat-activity.tsx"), "utf8"),
    readFile(join(ui, "transcript-turn.tsx"), "utf8"),
    readFile(join(ext, "orb/orb-overlay.ts"), "utf8"),
  ]);
  for (const [name, source] of [
    ["mini-swarm", swarm],
    ["lattice-mark", lattice],
    ["pending-work", pending],
    ["chat-activity", activity],
    ["transcript-turn", turn],
  ]) {
    assert.match(source, /from "\.\/visible-work\.js"/, `${name} must use the visibility gate`);
    assert.doesNotMatch(source, /requestAnimationFrame\(/, `${name} must not schedule raw frames`);
    assert.doesNotMatch(source, /setInterval\(/, `${name} must not schedule raw timers`);
  }
  assert.match(
    lattice,
    /if \(still\)[\s\S]{0,160}return \(\) => \{\}/,
    "an idle home mark must draw once and schedule nothing",
  );
  assert.match(orb, /visibilitychange/, "the cursor loop must pause when the tab is hidden");
  const favicon = await readFile(join(ext, "status-favicon.ts"), "utf8");
  assert.match(favicon, /document\.hidden/, "the chat favicon spinner must pause when hidden");
  assert.match(favicon, /visibilitychange/, "the chat favicon spinner must resume only when seen");
  assert.match(orb, /frameGap/, "the cursor loop must cap its frame rate");
  const placePill = orb.match(/private placePill[\s\S]*?\n\s{2}\}/)?.[0] ?? "";
  assert.doesNotMatch(placePill, /offsetWidth/, "the cursor must not force layout every frame");
});
