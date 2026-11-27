import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionKeepalive,
  judgeSession,
  readKeepaliveSites,
  writeKeepaliveSites,
} from "../dist/session-keepalive.js";

const site = { id: "mail", url: "https://mail.example.com/api/me", intervalMs: 1000 };

function response(status, { body = "", location, url = site.url } = {}) {
  return {
    status,
    url,
    headers: new globalThis.Headers(location ? { location } : {}),
    text: async () => body,
  };
}

function harness(answers) {
  const timers = [];
  const events = [];
  const requests = [];
  let modelCalls = 0;
  const keepalive = new SessionKeepalive({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return answers.shift() ?? response(200);
    },
    headers: async () => ({ cookie: "sid=SECRET-SESSION" }),
    onEvent: (event) => events.push(event),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: (handle) => (timers[handle - 1] = undefined),
    now: () => 1_700_000_000_000,
  });
  return { keepalive, timers, events, requests, modelCalls: () => modelCalls };
}

test("judging an answer", () => {
  assert.equal(
    judgeSession(site, { status: 200, url: site.url, body: '{"user":1}' }).health,
    "healthy",
  );
  assert.equal(judgeSession(site, { status: 401, url: site.url, body: "" }).health, "expired");
  assert.equal(
    judgeSession(site, { status: 302, url: site.url, location: "/login?next=/", body: "" }).reason,
    "redirected to sign-in",
  );
  assert.equal(
    judgeSession(
      { ...site, signedOutMarkers: ["Sign in to continue"] },
      { status: 200, url: site.url, body: "<h1>sign in to continue</h1>" },
    ).health,
    "expired",
  );
  assert.equal(judgeSession(site, { status: 503, url: site.url, body: "" }).health, "unknown");
});

test("healthy to expired raises one reauth event, backs off, recovers, and stops cleanly", async () => {
  const h = harness([response(200), response(401), response(401), response(200)]);
  h.keepalive.register(site);
  assert.equal(h.timers[0].ms, 0, "first check right away");
  assert.equal((await h.keepalive.check("mail")).health, "healthy");
  assert.equal(h.timers.at(-1).ms, 1000);
  const expired = await h.keepalive.check("mail");
  assert.equal(expired.health, "expired");
  assert.equal(h.timers.at(-1).ms, 2000, "backoff doubles");
  await h.keepalive.check("mail");
  assert.equal(h.timers.at(-1).ms, 4000);
  assert.deepEqual(
    h.events.map((e) => e.type),
    ["reauth-needed"],
  );
  await h.keepalive.check("mail");
  assert.deepEqual(
    h.events.map((e) => e.type),
    ["reauth-needed", "recovered"],
  );
  assert.equal(h.requests[0].init.redirect, "manual");
  assert.equal(JSON.stringify([h.events, h.keepalive.list()]).includes("SECRET-SESSION"), false);
  assert.equal(h.modelCalls(), 0);
  h.keepalive.stop();
  assert.ok(
    h.timers.every((t) => t === undefined),
    "no timer left after stop",
  );
});

test("a known expiry soon is 'expiring'; network errors keep the last health", async () => {
  const h = harness([response(200), Promise.reject(new Error("offline"))]);
  h.keepalive.register({ ...site, expiresAt: 1_700_000_000_000 + 3600_000 });
  assert.equal((await h.keepalive.check("mail")).health, "expiring");
  assert.equal(h.events[0].type, "expiring");
  const after = await h.keepalive.check("mail");
  assert.equal(after.health, "expiring");
  assert.match(after.reason, /unreachable/);
  h.keepalive.stop();
});

test(
  "registered sites live in a private file",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = join(await mkdtemp(join(tmpdir(), "graft-keepalive-")), "data");
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeKeepaliveSites(dir, [site]);
    assert.deepEqual(await readKeepaliveSites(dir), [site]);
    assert.equal((await stat(join(dir, "session-keepalive.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  },
);
