import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKER_MS,
  HumanBudget,
  MAX_WHY_CHARS,
  breakageOf,
  captchaHandoff,
  clearBreaker,
  explainBreakage,
  getBreakerState,
  isRung0Paused,
  loadBreakers,
  recordChallenge,
  setBreakerClock,
  setBreakerPersistence,
} from "../dist/index.js";
import { Challenged } from "../dist/runtime/index.js";

let now = 1_000_000;
setBreakerClock({ now: () => now });

test("I-8: first challenge trips the breaker for 24 hours, then it expires", () => {
  clearBreaker();
  assert.equal(isRung0Paused("shop.example"), false);
  const state = recordChallenge("shop.example", { vendor: "datadome" });
  assert.equal(state.until - state.trippedAt, BREAKER_MS);
  assert.equal(isRung0Paused("shop.example"), true);
  now += BREAKER_MS - 1;
  recordChallenge("shop.example", { vendor: "cloudflare" });
  assert.equal(getBreakerState("shop.example").vendor, "datadome", "keeps the first window");
  now += 1;
  assert.equal(isRung0Paused("shop.example"), false);
  assert.equal(getBreakerState("shop.example"), undefined);
});

test("I-8: (site, account) pairs are isolated and clear manually", () => {
  clearBreaker();
  recordChallenge("a.example", { vendor: "akamai" }, "alice");
  assert.equal(isRung0Paused("a.example", "alice"), true);
  assert.equal(isRung0Paused("a.example"), false);
  assert.equal(isRung0Paused("b.example", "alice"), false);
  clearBreaker("a.example", "alice");
  assert.equal(isRung0Paused("a.example", "alice"), false);
});

test("I-8: persistence hook saves and restores live breakers", () => {
  clearBreaker();
  let saved = [];
  setBreakerPersistence((states) => (saved = JSON.parse(JSON.stringify(states))));
  recordChallenge("p.example", { vendor: "perimeterx" });
  assert.equal(saved.length, 1);
  setBreakerPersistence();
  clearBreaker();
  loadBreakers(saved);
  assert.equal(isRung0Paused("p.example"), true);
  clearBreaker();
});

/** A virtual clock: waits resolve only when the test advances time. */
function fakeClock() {
  const clock = {
    t: 0,
    timers: [],
    now: () => clock.t,
    wait: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        clock.timers.push({ at: clock.t + ms, resolve });
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        await flush();
        clock.timers.sort((a, b) => a.at - b.at);
        const next = clock.timers[0];
        if (!next || next.at > end) break;
        clock.timers.shift();
        clock.t = next.at;
        next.resolve();
      }
      clock.t = end;
      await flush();
    },
  };
  return clock;
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test("I-4: writes over 1/s queue in FIFO order instead of failing", async () => {
  const clock = fakeClock();
  const budget = new HumanBudget(clock);
  const order = [];
  const all = [1, 2, 3].map((n) =>
    budget.acquire("w.example", { kind: "write" }).then(() => order.push([n, clock.t])),
  );
  await clock.advance(0);
  assert.deepEqual(order, [[1, 0]]);
  await clock.advance(1000);
  await clock.advance(1000);
  await Promise.all(all);
  assert.deepEqual(order, [
    [1, 0],
    [2, 1000],
    [3, 2000],
  ]);
});

test("I-4: the 61st read in a minute waits for the window", async () => {
  const clock = fakeClock();
  const budget = new HumanBudget(clock);
  let done = 0;
  for (let i = 0; i < 61; i++)
    void budget.acquire("r.example", { kind: "read" }).then(() => done++);
  await clock.advance(0);
  assert.equal(done, 60);
  await clock.advance(59_999);
  assert.equal(done, 60);
  await clock.advance(1);
  assert.equal(done, 61);
});

test("I-4: at most two lanes on a vendor origin; a release lets the next in", async () => {
  const clock = fakeClock();
  const budget = new HumanBudget(clock);
  const releases = [];
  for (let i = 0; i < 3; i++)
    void budget.acquire("v.example", { kind: "lane" }).then((r) => releases.push(r));
  await clock.advance(0);
  assert.equal(releases.length, 2);
  releases[0]();
  releases[0]();
  await clock.advance(0);
  assert.equal(releases.length, 3);
});

test("I-4: observed human rates raise caps, clamped at 3x", () => {
  const budget = new HumanBudget(fakeClock());
  assert.deepEqual(budget.observeHumanRate("x.example", { lanes: 10, writesPerSecond: 2 }), {
    lanes: 6,
    writesPerSecond: 2,
    readsPerMinute: 60,
  });
  assert.equal(budget.observeHumanRate("x.example", { readsPerMinute: 1000 }).readsPerMinute, 180);
  assert.equal(budget.observeHumanRate("x.example", { lanes: 1 }).lanes, 6, "never lowers");
});

test("I-4: a queued wait respects abort and timeout", async () => {
  const clock = fakeClock();
  const budget = new HumanBudget(clock);
  await budget.acquire("c.example", { kind: "write" });
  const controller = new AbortController();
  const aborted = budget.acquire("c.example", { kind: "write", signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(aborted, /stop/);
  const timed = budget.acquire("c.example", { kind: "lane" });
  await timed;
  await budget.acquire("c.example", { kind: "lane" });
  const late = budget.acquire("c.example", { kind: "lane", timeoutMs: 500 });
  const check = assert.rejects(late, (error) => error.name === "TimeoutError");
  await clock.advance(500);
  await check;
});

test("I-7: a vendor wall routes to a captcha handoff, never a retry", () => {
  const handoff = captchaHandoff("shop.example", { vendor: "kasada" }, "https://shop.example/x");
  assert.equal(handoff.kind, "captcha");
  assert.equal(handoff.vendor, "kasada");
  assert.equal(handoff.url, "https://shop.example/x");
  assert.equal(handoff.retry, false);
  const error = new Challenged(
    "search",
    { status: 403, headers: {}, text: "", url: "https://shop.example/api" },
    { vendor: "cloudflare", evidence: "cf-mitigated: challenge" },
  );
  assert.equal(error.handoff.kind, "captcha");
  assert.equal(error.handoff.url, "https://shop.example/api");
  assert.match(error.handoff.why, /^shop\.example showed a Cloudflare verification wall/);
  assert.match(error.message, /^SITE_BLOCKED/, "existing error text survives");
  assert.equal(breakageOf("shop.example", error).kind, "wall");
});

test("explainBreakage: one plain sentence per category", () => {
  const cases = [
    [
      {
        kind: "breaker",
        site: "shop.example",
        vendor: "datadome",
        until: Date.UTC(2026, 10, 26, 9, 30),
      },
      "shop.example tripped a DataDome check, so direct API calls are paused until 2026-11-26 09:30 UTC and runs use the live page instead.",
    ],
    [
      { kind: "wall", site: "shop.example", vendor: "perimeterx" },
      "shop.example showed a PerimeterX verification wall, so it was handed to you in Chrome instead of retrying.",
    ],
    [
      { kind: "auth", site: "mail.example", status: 401 },
      "mail.example signed you out, so sign in again in Chrome and rerun it.",
    ],
    [
      { kind: "rate-limit", site: "api.example", retryAfterSeconds: 30 },
      "api.example asked us to slow down, so try again in 30 seconds.",
    ],
    [
      { kind: "rate-limit", site: "api.example" },
      "api.example asked us to slow down, so try again in a little while.",
    ],
    [
      { kind: "drift", site: "news.example", missing: "price" },
      'news.example changed its page and "price" is no longer there, so this step needs updating.',
    ],
    [
      { kind: "network", site: "x.example" },
      "x.example could not be reached, so check your connection and try again.",
    ],
    [
      { kind: "network", site: "x.example", timeout: true },
      "x.example took too long to answer, so check your connection and try again.",
    ],
  ];
  for (const [event, expected] of cases) {
    const text = explainBreakage(event);
    assert.equal(text, expected);
    assert.ok(text.length <= MAX_WHY_CHARS);
    assert.equal(text.match(/\. /g), null, "one sentence");
  }
  const long = explainBreakage({ kind: "drift", site: "s.example", missing: "x".repeat(300) });
  assert.ok(long.length <= MAX_WHY_CHARS && long.endsWith("."));
});

test("breakageOf maps auth, rate limits and network failures", () => {
  assert.equal(breakageOf("s", { name: "SignedOut", response: { status: 403 } }).kind, "auth");
  assert.deepEqual(
    breakageOf("s", { response: { status: 429, headers: { "retry-after": "12" } } }),
    {
      kind: "rate-limit",
      site: "s",
      retryAfterSeconds: 12,
    },
  );
  assert.equal(breakageOf("s", new Error("fetch failed")).kind, "network");
  assert.equal(breakageOf("s", { name: "TimeoutError", message: "x" }).timeout, true);
  assert.equal(breakageOf("s", new Error("something else")), undefined);
});
