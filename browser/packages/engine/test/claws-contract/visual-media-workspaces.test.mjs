// Wave 3B claws: canvas, pixel-region diff and occlusion, the tab audio and caption tap, tab
// groups, workspaces, picture-in-picture and the tab-suspension governor. DevTools and Chrome
// are stubbed, so every command the claws send is observable and nothing runs before a call.
import assert from "node:assert/strict";
import test from "node:test";
import {
  byteDelta,
  forgetVisual,
  normalClip,
  visualCall,
} from "../../dist/native-browser-visual-claws.js";
import {
  CUE_LIMIT,
  captionTabs,
  forgetCaptions,
  mediaTapCall,
  scrubCue,
} from "../../dist/native-browser-media-tap.js";
import {
  eligibleForSuspension,
  pipCall,
  workspacesCall,
} from "../../dist/native-browser-workspaces.js";
import { EFFECTS } from "../../dist/kernel-effects.js";

// A fake DevTools channel: records commands, answers Runtime.evaluate through `page`.
function fakeCdp(page = () => undefined, shots = []) {
  const calls = [];
  const cdp = async (method, params) => {
    calls.push({ method, params });
    if (method === "Page.captureScreenshot") return { data: shots.shift() };
    if (method === "Runtime.evaluate") return { result: { value: await page(params.expression) } };
    return {};
  };
  return { cdp, calls };
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

test("idle: loading the claws sends no command and adds no listener", () => {
  const { calls } = fakeCdp();
  assert.equal(calls.length, 0);
  assert.deepEqual(captionTabs(), []);
});

test("the new effects are declared with the checks they need", () => {
  const byName = Object.fromEntries(EFFECTS.map((doc) => [doc.name, doc]));
  for (const name of ["page.visual", "page.mediaTap", "page.pip"])
    assert.deepEqual(byName[name].needs, ["tab"]);
  assert.deepEqual(byName["browser.workspaces"].needs, []);
});

test("canvas inspection evaluates once and returns the page's list", async () => {
  const listed = [
    {
      index: 0,
      id: "chart",
      width: 300,
      height: 150,
      context: "2d",
      box: { x: 0, y: 0, width: 300, height: 150 },
    },
  ];
  const { cdp, calls } = fakeCdp(() => listed);
  const answer = await visualCall(1, { visual: "canvas" }, cdp);
  assert.deepEqual(answer.canvases, listed);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["Runtime.evaluate"],
  );
});

test("canvas text tap: list before start says not tapping; start/stop reach the page", async () => {
  const seen = [];
  const { cdp } = fakeCdp((expression) => {
    const action = JSON.parse(expression.slice(expression.lastIndexOf(")(") + 2, -1)).action;
    seen.push(action);
    return action === "list" ? null : { [action === "start" ? "started" : "stopped"]: true };
  });
  assert.deepEqual(await visualCall(1, { visual: "canvasTap", action: "list" }, cdp), {
    texts: [],
    tapping: false,
  });
  assert.equal((await visualCall(1, { visual: "canvasTap", action: "start" }, cdp)).started, true);
  assert.equal((await visualCall(1, { visual: "canvasTap", action: "stop" }, cdp)).stopped, true);
  assert.deepEqual(seen, ["list", "start", "stop"]);
  await assert.rejects(
    visualCall(1, { visual: "canvasTap", action: "bogus" }, cdp),
    /INVALID_INPUT/,
  );
});

test("region diff: identical region = 0, changed region > 0, with a sha256 and the clip", async () => {
  const a = new Uint8Array(1000).fill(7);
  const changed = a.slice();
  changed.fill(9, 0, 250);
  const { cdp, calls } = fakeCdp(undefined, [b64(a), b64(a), b64(changed)]);
  const clip = { x: 10, y: 20, width: 50, height: 40 };
  const first = await visualCall(2, { visual: "regionDiff", clip, baseline: "hero" }, cdp);
  assert.equal(first.first, true);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  const same = await visualCall(2, { visual: "regionDiff", clip, baseline: "hero" }, cdp);
  assert.equal(same.diffRatio, 0);
  assert.equal(same.changed, false);
  const diff = await visualCall(2, { visual: "regionDiff", clip, baseline: "hero" }, cdp);
  assert.equal(diff.changed, true);
  assert.ok(diff.diffRatio > 0 && diff.diffRatio <= 1);
  assert.deepEqual(calls[0].params.clip, { ...clip, scale: 1 });
  forgetVisual(2);
  assert.throws(() => normalClip({ x: 1 }), /INVALID_INPUT/);
});

test("byte delta is deterministic", () => {
  assert.equal(byteDelta(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 4])), 0);
  assert.equal(byteDelta(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 0, 3, 0])), 0.5);
});

test("occlusion: clear vs covered by an overlay; a missing target raises", async () => {
  const clear = {
    occluded: false,
    partial: false,
    offscreen: false,
    topElement: { tag: "button" },
    targetRect: { x: 0, y: 0, width: 10, height: 10 },
  };
  const covered = {
    ...clear,
    occluded: true,
    topElement: { tag: "div", className: "modal-backdrop" },
  };
  let next = clear;
  const { cdp } = fakeCdp(() => next);
  assert.equal(
    (await visualCall(3, { visual: "occlusion", visualTarget: "#buy" }, cdp)).occluded,
    false,
  );
  next = covered;
  const hit = await visualCall(3, { visual: "occlusion", visualTarget: { selector: "#buy" } }, cdp);
  assert.equal(hit.occluded, true);
  assert.equal(hit.topElement.className, "modal-backdrop");
  next = { error: "TARGET_NOT_FOUND: no element matches #x" };
  await assert.rejects(
    visualCall(3, { visual: "occlusion", visualTarget: "#x" }, cdp),
    /TARGET_NOT_FOUND/,
  );
});

test("audio state joins the tab's audible/muted flags with its media elements", async () => {
  const elements = [
    { tag: "video", paused: false, currentTime: 3, duration: 60, muted: false, playbackRate: 1 },
  ];
  const { cdp } = fakeCdp(() => elements);
  const tabs = { get: async () => ({ audible: true, mutedInfo: { muted: false } }) };
  const state = await mediaTapCall(4, { mediaTap: "audioState" }, { cdp, tabs });
  assert.equal(state.audible, true);
  assert.equal(state.muted, false);
  assert.deepEqual(state.elements, elements);
});

// A page-side ring buffer stand-in that honours the tap's read/start/stop protocol.
function captionPage() {
  let tap;
  const page = (expression) => {
    const arg = JSON.parse(expression.slice(expression.lastIndexOf(")(") + 2, -1));
    if (arg.action === "start") {
      tap ??= { cues: [], seq: 0 };
      return { started: true };
    }
    if (arg.action === "stop") {
      const had = Boolean(tap);
      tap = undefined;
      return { stopped: had };
    }
    return tap ? { cues: tap.cues.filter((c) => c.at > (arg.after ?? 0)), seq: tap.seq } : null;
  };
  const push = (text, source = "track:en") => {
    tap.cues.push({ text, source, at: ++tap.seq });
    if (tap.cues.length > CUE_LIMIT) tap.cues.shift();
  };
  return { page, push, active: () => Boolean(tap) };
}

test("captions: start/list/stop with a bounded buffer, scrubbing and full teardown", async () => {
  const fake = captionPage();
  const { cdp, calls } = fakeCdp(fake.page);
  const closers = [];
  const deps = { cdp, tabs: { get: async () => ({}) }, onClosed: (fn) => closers.push(fn) };
  assert.deepEqual(await mediaTapCall(5, { mediaTap: "captionsList" }, deps), {
    cues: [],
    watching: false,
  });
  await mediaTapCall(5, { mediaTap: "captionsStart" }, deps);
  assert.deepEqual(captionTabs(), [5]);
  assert.equal(closers.length, 1, "the close listener is added only at the first start");
  for (let i = 0; i < CUE_LIMIT + 20; i++) fake.push(`line ${i}`);
  fake.push("your code: 123456 and mail ada@example.com");
  const listed = await mediaTapCall(5, { mediaTap: "captionsList" }, deps);
  assert.equal(listed.cues.length, CUE_LIMIT);
  const last = listed.cues.at(-1).text;
  assert.doesNotMatch(last, /123456|ada@example\.com/);
  await mediaTapCall(5, { mediaTap: "captionsStop" }, deps);
  assert.equal(fake.active(), false);
  assert.deepEqual(captionTabs(), []);
  assert.ok(calls.every((c) => c.method === "Runtime.evaluate"));
  closers[0](5);
  forgetCaptions(5);
});

test("captions.waitFor resolves on a matching cue and times out otherwise", async () => {
  const fake = captionPage();
  const { cdp } = fakeCdp(fake.page);
  let ticks = 0;
  const deps = {
    cdp,
    tabs: { get: async () => ({}) },
    sleep: async () => {
      if (++ticks === 2) fake.push("Breaking: launch is live");
    },
  };
  await assert.rejects(
    mediaTapCall(6, { mediaTap: "captionsWait", filter: "x" }, deps),
    /start\(\) first/,
  );
  await mediaTapCall(6, { mediaTap: "captionsStart" }, deps);
  const found = await mediaTapCall(
    6,
    { mediaTap: "captionsWait", filter: { text: "launch" }, timeoutMs: 5000 },
    deps,
  );
  assert.match(found.cue.text, /launch is live/);
  await assert.rejects(
    mediaTapCall(
      6,
      { mediaTap: "captionsWait", filter: "never", timeoutMs: 100 },
      { ...deps, sleep: () => new Promise((r) => setTimeout(r, 60)) },
    ),
    /TIMEOUT/,
  );
  await mediaTapCall(6, { mediaTap: "captionsStop" }, deps);
});

test("scrubCue removes tokens, addresses and key=value secrets", () => {
  assert.equal(scrubCue("password=hunter2 ok"), "password: <redacted> ok");
  assert.doesNotMatch(scrubCue("eyJabcdefgh.eyJabcdefgh.abcdefghij"), /eyJ/);
});

function fakeChrome(tabs, groups = []) {
  const store = {};
  const log = [];
  let nextTab = 100;
  return {
    log,
    store,
    api: {
      tabs: {
        query: async () => tabs,
        group: async (o) => (log.push(["group", o]), o.groupId ?? 9),
        ungroup: async (ids) => log.push(["ungroup", ids]),
        update: async (id, p) => log.push(["update", id, p]),
        discard: async (id) => (log.push(["discard", id]), { id }),
        create: async (o) => (log.push(["create", o.url]), { id: nextTab++ }),
      },
      tabGroups: {
        query: async () => groups,
        update: async (id, p) => log.push(["groupUpdate", id, p]),
      },
      storage: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (items) => Object.assign(store, items),
      },
      now: () => 1_000_000,
    },
  };
}

test("tab groups: list, group with title/colour, ungroup, update; bad colour refused", async () => {
  const { api, log } = fakeChrome(
    [],
    [{ id: 1, title: "Work", color: "blue", collapsed: false, windowId: 1 }],
  );
  assert.equal((await workspacesCall(api, { workspaces: "list" })).groups[0].title, "Work");
  assert.equal(
    (await workspacesCall(api, { workspaces: "group", tabIds: [3, 4], title: "R", color: "red" }))
      .groupId,
    9,
  );
  await workspacesCall(api, { workspaces: "ungroup", tabIds: 3 });
  await workspacesCall(api, { workspaces: "update", groupId: 1, patch: { collapsed: true } });
  assert.deepEqual(
    log.map((e) => e[0]),
    ["group", "groupUpdate", "ungroup", "groupUpdate"],
  );
  await assert.rejects(
    workspacesCall(api, { workspaces: "group", tabIds: [1], color: "neon" }),
    /INVALID_INPUT/,
  );
});

test("workspaces save only {title, color, urls} and restore them as groups", async () => {
  const tabs = [
    { id: 1, groupId: 1, url: "https://a.test/", title: "secret title" },
    { id: 2, groupId: 1, url: "chrome://settings" },
    { id: 3, groupId: -1, url: "https://b.test/" },
  ];
  const { api, log, store } = fakeChrome(tabs, [{ id: 1, title: "Research", color: "green" }]);
  assert.deepEqual(await workspacesCall(api, { workspaces: "save", name: "day" }), {
    saved: "day",
    groups: 1,
    tabs: 1,
  });
  assert.deepEqual(store["graft-workspaces"][0].groups, [
    { title: "Research", color: "green", urls: ["https://a.test/"] },
  ]);
  assert.equal((await workspacesCall(api, { workspaces: "listSaved" })).workspaces[0].name, "day");
  const restored = await workspacesCall(api, { workspaces: "restore", name: "day" });
  assert.equal(restored.groups[0].title, "Research");
  assert.ok(log.some((e) => e[0] === "create" && e[1] === "https://a.test/"));
  assert.equal(
    (await workspacesCall(api, { workspaces: "removeSaved", name: "day" })).removed,
    true,
  );
  await assert.rejects(
    workspacesCall(api, { workspaces: "restore", name: "day" }),
    /no saved workspace/,
  );
});

test("pip reports structured status and turns a refusal into a reason", async () => {
  const { cdp, calls } = fakeCdp(() => ({
    videoSupported: true,
    documentSupported: false,
    active: false,
    mode: "none",
  }));
  assert.equal((await pipCall(cdp, { action: "status" })).mode, "none");
  assert.equal(calls[0].params.userGesture, true);
  const refused = async () => ({ exceptionDetails: { text: "NotAllowedError" } });
  assert.deepEqual(await pipCall(refused, { action: "enter" }), {
    entered: false,
    reason: "NotAllowedError",
  });
});

test("governor: protect flips autoDiscardable; suspendIdle keeps pinned/audible/active/protected", async () => {
  const now = 1_000_000;
  const tabs = [
    { id: 1, active: true, lastAccessed: 0 },
    { id: 2, pinned: true, lastAccessed: 0 },
    { id: 3, audible: true, lastAccessed: 0 },
    { id: 4, autoDiscardable: false, lastAccessed: 0 },
    { id: 5, lastAccessed: 0 },
    { id: 6, lastAccessed: now - 10 },
    { id: 7, discarded: true },
    { id: 8, lastAccessed: 0 },
  ];
  const { api, log } = fakeChrome(tabs);
  assert.deepEqual(
    await workspacesCall(api, { suspension: "protect", tabId: 8, protected: true }),
    { tabId: 8, protected: true },
  );
  assert.deepEqual(log[0], ["update", 8, { autoDiscardable: false }]);
  const result = await workspacesCall(api, {
    suspension: "suspendIdle",
    options: { olderThanMs: 60_000 },
  });
  assert.deepEqual(result, { suspendedTabIds: [5], skippedCount: 7 });
  await workspacesCall(api, { suspension: "protect", tabId: 8, protected: false });
  assert.equal(eligibleForSuspension({ id: 8, lastAccessed: 0 }, {}, now), true);
  assert.equal(eligibleForSuspension({ id: 2, pinned: true }, { keepPinned: false }, now), true);
  const status = await workspacesCall(api, { suspension: "status" });
  assert.deepEqual(status, { tabs: 8, active: 1, discarded: 1, protected: 1 });
});
