// page.read ends its settle wait on two quiet ticks, and those ticks count only after the page's
// first 1.5s. A tick that ran before the floor used to count too, so a read could return one tick
// before a client-rendered page drew its content: the "Late reply" read failed on a loaded Ubuntu
// runner for exactly that reason. __waitRead is page code, so this runs its real source against a
// pretend page and a virtual clock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/code-api-data.ts", import.meta.url), "utf8");
const start = source.indexOf("function __waitRead(");
const end = source.indexOf("\n}\n", start);
assert.ok(start >= 0 && end > start, "__waitRead is still a module-level page function");
const WAIT_READ = source.slice(start, end + 2);

/** A pretend page: `pageTime` is its own clock at the call, `textAt(pageTime)` its text length. */
function page({ pageTime, textAt, resourcesAt = () => 0 }) {
  const clock = { now: 0, timers: [] };
  const root = {
    get innerText() {
      return "x".repeat(textAt(pageTime + clock.now));
    },
  };
  const sandbox = {
    document: { querySelector: () => root, body: root },
    performance: {
      now: () => pageTime + clock.now,
      getEntriesByType: () => Array.from({ length: resourcesAt(pageTime + clock.now) }, () => ({})),
    },
    Date: { now: () => 1_000_000 + clock.now },
    setTimeout: (fn, ms) => clock.timers.push({ at: clock.now + ms, fn }),
    Math,
    Number,
  };
  const waitRead = vm.runInNewContext(`${WAIT_READ}\n__waitRead`, sandbox);
  return { clock, waitRead };
}

/** Runs the wait on its own timers, advancing the virtual clock to each one. */
async function settle(page, options = {}) {
  let result;
  page.waitRead(options).then((value) => {
    result = value;
  });
  while (result === undefined) {
    const timer = page.clock.timers.shift();
    if (!timer) {
      await new Promise((done) => setImmediate(done));
      if (result === undefined) throw new Error("__waitRead never finished");
      break;
    }
    page.clock.now = timer.at;
    timer.fn();
    await new Promise((done) => setImmediate(done));
  }
  return result;
}

test("a late first render inside the first 1.5s is not missed", async () => {
  // The read starts 300 ms after the page loaded; the page draws its content at 1550 ms, after the
  // tick that crosses the floor. Quiet ticks before the floor must not end the wait.
  const drawnAt = 1550;
  const before = 10;
  const after = 200;
  const subject = page({
    pageTime: 300,
    textAt: (at) => (at >= drawnAt ? after : before),
  });
  const result = await settle(subject);
  assert.equal(result.settled, true);
  assert.equal(result.chars, after, "the read ended before the page drew its content");
});

test("a page loaded long ago still returns in about two ticks", async () => {
  const subject = page({ pageTime: 10_000, textAt: () => 50 });
  const result = await settle(subject);
  assert.equal(result.settled, true);
  assert.equal(result.chars, 50);
  assert.ok(result.ms <= 500, `a quiet old page waited ${result.ms} ms`);
});

test("a page that keeps changing is partial at the cap", async () => {
  const subject = page({ pageTime: 10_000, textAt: (at) => at - 10_000 });
  const result = await settle(subject, { maxMs: 1000 });
  assert.equal(result.settled, false);
  assert.equal(result.partial, true);
  assert.match(result.note, /still changing after 1000 ms/);
});
