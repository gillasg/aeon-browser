import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import {
  matchesListenResponse,
  matchesListenType,
  matchesListenUrl,
  optionalListen,
  siteOfUrl,
  tabMatchesListen,
} from "../dist/routine-listen.js";
import { liveCheckCode } from "../dist/routine-listen.js";
import { RoutineScheduler } from "../dist/routine-scheduler.js";

const tick = () => new Promise((done) => setImmediate(done));
const settle = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- matching

test("listen.url matches response URLs by substring", () => {
  const listen = { url: "/api/status" };
  assert.equal(matchesListenUrl("https://shop.test/api/status?x=1", listen), true);
  assert.equal(matchesListenUrl("https://shop.test/api/orders", listen), false);
  assert.equal(matchesListenUrl("https://other.test/api/status", listen), true);
  assert.equal(matchesListenUrl("anything", { url: "" }), false);
});

test("listen.type filters by resource type or MIME, like page.network", () => {
  assert.equal(matchesListenType({ type: "Fetch", mimeType: "application/json" }, "json"), true);
  assert.equal(matchesListenType({ type: "XHR", mimeType: "text/html" }, "json"), false);
  assert.equal(
    matchesListenType({ type: "Fetch", mimeType: "application/ld+json" }, "+json"),
    true,
  );
  assert.equal(matchesListenType({ type: "Image", mimeType: "image/png" }, "image/"), true);
  assert.equal(matchesListenType({ type: "XHR" }, "XHR"), true);
});

test("a response is a match only when both its URL and type fit", () => {
  const listen = { url: "/api/status", type: "json" };
  assert.equal(
    matchesListenResponse(
      { url: "https://shop.test/api/status", type: "Fetch", mimeType: "application/json" },
      listen,
    ),
    true,
  );
  assert.equal(
    matchesListenResponse(
      { url: "https://shop.test/api/status", type: "Fetch", mimeType: "text/html" },
      listen,
    ),
    false,
  );
  assert.equal(
    matchesListenResponse(
      { url: "https://shop.test/api/orders", type: "Fetch", mimeType: "application/json" },
      listen,
    ),
    false,
  );
});

test("optionalListen parses, keeps on update and removes on null", () => {
  assert.deepEqual(optionalListen({ url: "/api/x", type: "json" }), {
    url: "/api/x",
    type: "json",
  });
  assert.deepEqual(optionalListen({ url: "/api/x" }), { url: "/api/x" });
  assert.deepEqual(optionalListen(undefined, { url: "/kept" }), { url: "/kept" });
  assert.equal(optionalListen(null, { url: "/kept" }), null);
  assert.throws(() => optionalListen({ type: "json" }), /listen.url/);
  assert.throws(() => optionalListen("nope"), /listen must be/);
});

test("tab matching uses the routine's sites, else the listen URL", () => {
  const listen = { url: "/api/status" };
  assert.equal(siteOfUrl("https://www.Shop.test/dash"), "shop.test");
  // With sites, any tab of the watched site is eligible (the API URL need not appear in it).
  assert.equal(tabMatchesListen("https://shop.test/dashboard", listen, ["shop.test"]), true);
  assert.equal(tabMatchesListen("https://other.test/", listen, ["shop.test"]), false);
  // Without sites, the listen URL part must appear in the tab's own URL.
  assert.equal(tabMatchesListen("https://shop.test/api/status", listen, []), true);
  assert.equal(tabMatchesListen("https://shop.test/dashboard", listen, []), false);
});

test("generated live code attaches to an existing tab, waits for a response, runs the check", () => {
  const code = liveCheckCode(
    "const r = browser.changes('s', response.body.items); r.new.length ? r.new : false",
    { url: "/api/status", type: "json" },
    ["shop.test"],
  );
  assert.match(code, /browser\.tabs\(\)/);
  assert.match(code, /browser\.tab\(/);
  assert.doesNotMatch(code, /browser\.openTab\(/); // never open a tab just to listen
  assert.match(code, /waitForResponse\("\/api\/status", \{type: "json", timeoutMs: 55000\}\)/);
  assert.match(code, /var response = __aeonLiveFound/);
  assert.match(code, /browser\.changes\('s', response\.body\.items\)/);
});

test("generated live code signals idle when no tab matches", () => {
  const code = liveCheckCode("return 1", { url: "/api/x" }, []);
  assert.match(code, /if \(!__aeonLiveTab\) return \{__liveIdle: true\}/);
  assert.match(code, /if \(!__aeonLiveFound\) return \{__liveIdle: true\}/);
});

// --------------------------------------------------------- dedupe / fallback

function harness(options = {}) {
  const run = {
    runId: "run-live",
    routineId: "routine-live",
    chatId: "chat-live",
    scheduledSlot: "2030-01-01T00:00:00.000Z",
    state: "due",
  };
  const routine = {
    routineId: run.routineId,
    chatId: run.chatId,
    title: "Status",
    instruction: "Tell me when the status flips.",
    check:
      options.check ??
      "const r = browser.changes('s', response.body.items); r.new.length ? r.new : false",
    sites: ["shop.test"],
    listen: options.listen === undefined ? { url: "/api/status", type: "json" } : options.listen,
    enabled: true,
    deletedAt: null,
    requiredBrowserInstanceId: null,
    schedule: { kind: "interval", everyMinutes: 5, anchorUtc: run.scheduledSlot, timeZone: "UTC" },
    nextDueAt: run.scheduledSlot,
    revision: 1,
  };
  const executed = [];
  const browser = {
    isInstanceAvailable: () => true,
    execute: async (chatId, toolCallId, raw) => {
      const input = { chatId, toolCallId, ...raw.codeCell };
      executed.push(input);
      return options.answer ? options.answer(input, executed) : JSON.stringify({ value: false });
    },
  };
  const queue = options.dueRun === true ? [run] : [];
  const store = {
    listOpenRoutineRuns: () => [],
    listDueRoutines: () => [],
    listDueRoutineRuns: () => queue.splice(0),
    getRoutine: () => routine,
    listRoutines: () => [routine],
    createManualRoutineRun: ({ runId, routineId, chatId, scheduledSlot }) => {
      const manual = { runId, routineId, chatId, scheduledSlot, state: "due" };
      queue.push(manual);
      return manual;
    },
    updateRoutineRun: () => undefined,
  };
  const invoked = [];
  const chats = {
    getChat: () => ({ status: "ready" }),
    beginRoutineRun: () => undefined,
    endRoutineRun: () => undefined,
    withSession: async (_chatId, action) =>
      action({
        subscribeRoutineRuns: () => () => undefined,
        findRoutineRun: () => ({ state: "not-found" }),
        invokeRoutine: async (invocation) => {
          invoked.push(invocation);
          return { piEntryId: "entry-1" };
        },
      }),
  };
  const scheduler = new RoutineScheduler(store, chats, browser, "data");
  return { scheduler, executed, invoked, routine };
}

test("a live response fires the routine; a repeat (deduped by the check) does not", async () => {
  let liveCalls = 0;
  const { scheduler, invoked, executed } = harness({
    // The live check returns truthy once (a new item) then falsy (the same item again). That is the
    // same "new since last time" result a timer check's browser.changes would produce.
    answer: (input) => {
      if (input.code.includes("__liveIdle")) {
        liveCalls += 1;
        return JSON.stringify({ value: liveCalls === 1 ? [{ id: "a" }] : false });
      }
      return JSON.stringify({ value: false });
    },
  });
  try {
    await scheduler.start();
    await settle(900); // two listener passes
    assert.equal(invoked.length, 1, "fires once on the new item");
    assert.match(invoked[0].instruction, /check passed with: \[\{"id":"a"\}\]/);
    assert.ok(executed.filter((c) => c.code.includes("__liveIdle")).length >= 2);
    // All live checks ran in the routine's own persistent realm.
    assert.ok(executed.every((c) => /^[0-9a-f]{8}-/.test(c.chatId)));
  } finally {
    scheduler.close();
  }
});

test("with no matching tab the live listener idles and the timer check runs", async () => {
  const { scheduler, invoked, executed } = harness({
    dueRun: true,
    answer: (input) => {
      if (input.code.includes("__liveIdle")) return JSON.stringify({ value: { __liveIdle: true } });
      return JSON.stringify({ value: { price: 380 } }); // normal timer check
    },
  });
  try {
    await scheduler.start();
    await tick();
    assert.equal(invoked.length, 1, "the timer fired");
    assert.match(invoked[0].instruction, /check passed with: \{"price":380\}/);
    const timerChecks = executed.filter((c) => !c.code.includes("__liveIdle"));
    assert.ok(timerChecks.length >= 1, "the plain check code ran");
    assert.ok(timerChecks.every((c) => c.code.includes("browser.changes")));
    // The live check never produced a firing value, so no extra agent run happened.
    assert.equal(invoked.length, 1);
  } finally {
    scheduler.close();
  }
});

test("a routine without a listen option is untouched by the live listener", async () => {
  const { scheduler, executed } = harness({
    listen: null,
    dueRun: true,
    answer: () => JSON.stringify({ value: false }),
  });
  try {
    await scheduler.start();
    await settle(400);
    assert.ok(executed.every((c) => !c.code.includes("__liveIdle")));
  } finally {
    scheduler.close();
  }
});
