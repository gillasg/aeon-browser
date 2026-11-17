import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctor } from "../dist/doctor-checks.js";
import { STEALTH_TRACE_URL, WEBRTC_FLAG, stealthChecks } from "../dist/doctor-stealth-checks.js";
import { parseStealthFacts } from "../dist/doctor-stealth-io.js";
import { runDoctor } from "../dist/doctor.js";

function cleanFacts(overrides = {}) {
  return {
    webrtc: { exitIp: "2401:4900:1c53:5c55:c12b:99af:c582:b003", candidates: [] },
    geo: { exitCountry: "IN", timeZone: "Asia/Kolkata", languages: ["en-US", "en"] },
    page: {
      webdriver: false,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      brands: ["Chromium 157", "Google Chrome 157", "Not-A.Brand 99"],
      screen: { width: 1600, height: 1200 },
      plugins: 5,
      mimeTypes: 5,
      signals: [],
      diagnostics: [
        "an isolated-world helper of Aeon's runs here (page code cannot read it): browserkit-helper",
      ],
    },
    ...overrides,
  };
}

function byName(checks) {
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

test("a clean, branded, exit-matched tab passes all three stealth checks", () => {
  const checks = stealthChecks(cleanFacts());
  assert.deepEqual(
    checks.map((check) => check.name),
    ["webrtc", "geo", "tells"],
  );
  assert.deepEqual(
    checks.map((check) => check.status),
    ["ok", "ok", "ok"],
  );
  assert.ok(checks.every((check) => check.fix));
  const text = stealthText(checks);
  assert.doesNotMatch(text, /Fix:/);
  assert.match(text, /webrtc +ok +WebRTC gathered no ICE candidates/);
});

test("an mDNS host candidate is not called a leak", () => {
  const checks = stealthChecks(
    cleanFacts({
      webrtc: { exitIp: "2401:4900::1", candidates: [{ type: "host", address: "abc.local" }] },
    }),
  );
  assert.equal(byName(checks).webrtc.status, "ok");
});

test("a WebRTC srflx candidate that is not the exit IP fails with the exact flag fix", () => {
  const checks = stealthChecks(
    cleanFacts({
      webrtc: {
        exitIp: "2401:4900:1c53:5c55:c12b:99af:c582:b003",
        candidates: [
          { type: "host", address: "4f3a.local" },
          { type: "srflx", address: "169.58.173.247" },
        ],
      },
    }),
  );
  const webrtc = byName(checks).webrtc;
  assert.equal(webrtc.status, "fail");
  assert.match(webrtc.detail, /169\.58\.173\.247/);
  assert.doesNotMatch(webrtc.detail, /\.local/);
  assert.equal(webrtc.fix.includes(WEBRTC_FLAG), true);
  assert.match(webrtc.fix, /disable_non_proxied_udp/);
  assert.match(STEALTH_TRACE_URL, /cloudflare\.com\/cdn-cgi\/trace/);
});

test("a time zone that disagrees with the exit country fails with the TZ and LANG fix", () => {
  const checks = stealthChecks(
    cleanFacts({
      geo: { exitCountry: "IN", timeZone: "Europe/Berlin", languages: ["de-DE", "de"] },
    }),
  );
  const geo = byName(checks).geo;
  assert.equal(geo.status, "fail");
  assert.match(geo.detail, /Europe\/Berlin/);
  assert.match(geo.fix, /TZ=Asia\/Kolkata/);
  assert.match(geo.fix, /LANG=en_IN\.UTF-8/);
});

test("the user's own en-US languages alone do not fail geo", () => {
  const checks = stealthChecks(
    cleanFacts({
      geo: { exitCountry: "IN", timeZone: "Asia/Kolkata", languages: ["en-US", "en"] },
    }),
  );
  assert.equal(byName(checks).geo.status, "ok");
  assert.match(byName(checks).geo.detail, /en-US/);
});

test("a missing Google Chrome client-hint brand fails with a stable-Chrome fix", () => {
  const checks = stealthChecks(
    cleanFacts({
      page: {
        ...cleanFacts().page,
        brands: ["Chromium 157", "Not-A.Brand 99"],
      },
    }),
  );
  const tells = byName(checks).tells;
  assert.equal(tells.status, "fail");
  assert.match(tells.detail, /Google Chrome client-hint brand is missing/);
  assert.match(tells.fix, /stable Google Chrome/);
});

test("webdriver, headless, zero screen, missing plugins and stealthCheck signals are all reported", () => {
  const checks = stealthChecks(
    cleanFacts({
      page: {
        webdriver: true,
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/157.0.0.0 Safari/537.36",
        brands: ["Chromium 157", "Google Chrome 157"],
        screen: { width: 0, height: 0 },
        plugins: 0,
        mimeTypes: 0,
        signals: ["navigator.webdriver is true (Chrome is in automation mode)"],
        diagnostics: [],
      },
    }),
  );
  const tells = byName(checks).tells;
  assert.equal(tells.status, "fail");
  for (const part of [
    "navigator.webdriver is true",
    "user agent says headless",
    "screen reports zero size",
    "plugins or MIME types are missing",
    "Chrome is in automation mode",
  ]) {
    assert.match(tells.detail, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(tells.fix, /real display/);
  assert.match(tells.fix, /default profile/);
  assert.match(tells.fix, /update Aeon/);
});

test("parseStealthFacts reads the trace, ICE, navigator and stealth report without altering them", () => {
  const raw = {
    traceText: "ip=2401:4900::1\nloc=in\nhttp=http",
    candidates: [{ type: "srflx", address: "169.58.173.247" }],
    nav: {
      webdriver: false,
      userAgent: "Chrome/157",
      brands: ["Google Chrome 157"],
      screen: { width: 1600, height: 900 },
      plugins: 5,
      mimeTypes: 5,
      timeZone: "Asia/Calcutta",
      languages: ["en-US", "en"],
    },
    signals: [],
    diagnostics: ["helper"],
  };
  const facts = parseStealthFacts(raw);
  assert.equal(facts.webrtc.exitIp, "2401:4900::1");
  assert.deepEqual(facts.webrtc.candidates, [{ type: "srflx", address: "169.58.173.247" }]);
  assert.equal(facts.geo.exitCountry, "IN");
  assert.equal(facts.geo.timeZone, "Asia/Calcutta");
  assert.deepEqual(facts.geo.languages, ["en-US", "en"]);
  assert.equal(facts.page.screen.width, 1600);
  assert.deepEqual(facts.page.signals, []);
  assert.deepEqual(facts.page.diagnostics, ["helper"]);
});

test("a probe error fails all three checks with the open-Chrome fix", () => {
  const checks = stealthChecks({ error: "BROWSER_OFFLINE" });
  assert.deepEqual(
    checks.map((check) => check.status),
    ["fail", "fail", "fail"],
  );
  for (const check of checks) {
    assert.match(check.detail, /BROWSER_OFFLINE/);
    assert.match(check.fix, /Open Chrome/);
  }
});

test("runDoctor --stealth prints three lines with fixes and a fail exit when a check leaks", async () => {
  let captured = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const code = await runDoctor(
      false,
      {
        stealthFacts: async () =>
          cleanFacts({
            webrtc: {
              exitIp: "2401:4900::1",
              candidates: [{ type: "srflx", address: "169.58.173.247" }],
            },
          }),
      },
      true,
    );
    assert.equal(code, 1);
    assert.equal((captured.match(/\n/g) || []).length >= 4, true);
    assert.match(captured, /webrtc +fail/);
    assert.match(captured, /Fix: Restart Chrome with --webrtc-ip-handling-policy/);
    assert.match(captured, /geo +ok/);
    assert.match(captured, /tells +ok/);
  } finally {
    process.stdout.write = write;
  }
});

test("runDoctor --stealth --json returns the three checks with ok false on a mismatch", async () => {
  let captured = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const code = await runDoctor(
      true,
      {
        stealthFacts: async () =>
          cleanFacts({
            geo: { exitCountry: "IN", timeZone: "Europe/Berlin", languages: ["en-US", "en"] },
          }),
      },
      true,
    );
    assert.equal(code, 1);
    const parsed = JSON.parse(captured);
    assert.equal(parsed.ok, false);
    assert.deepEqual(
      parsed.checks.map((check) => check.name),
      ["webrtc", "geo", "tells"],
    );
    assert.equal(byName(parsed.checks).geo.status, "fail");
    assert.ok(parsed.checks.every((check) => check.fix));
  } finally {
    process.stdout.write = write;
  }
});

function stealthText(checks) {
  // The stealth doctor uses the same formatter as the normal doctor.
  return formatDoctor(checks, false);
}
