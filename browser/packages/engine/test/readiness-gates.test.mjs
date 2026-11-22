import assert from "node:assert/strict";
import test from "node:test";
import { classifyReadiness, humanHandoff, waitOutInterstitial } from "../dist/readiness.js";

const page = {
  readyState: "complete",
  url: "https://shop.example/",
  title: "Shop",
  httpStatus: 200,
  textLength: 2400,
  textSample: "Browse products, deals and new arrivals.",
  heading: "Shop",
  links: 60,
  rows: 12,
  forms: 1,
  main: true,
};
const passive = {
  ...page,
  title: "Just a moment...",
  heading: "",
  textSample: "Checking your browser before accessing shop.example.",
  textLength: 60,
  rows: 0,
  main: false,
};

test("a JS check or meta refresh is a passive interstitial, with no handoff", () => {
  for (const snapshot of [
    passive,
    { ...page, title: "Redirect", metaRefresh: true, textLength: 20 },
  ]) {
    const result = classifyReadiness(snapshot);
    assert.equal(result.state, "challenge");
    assert.deepEqual(result.gate, { kind: "interstitial", interactive: false });
    assert.equal(humanHandoff(result), undefined);
  }
});

test("captcha, verification, 2FA and sign-in gates are interactive and hand off", () => {
  const cases = [
    [{ ...passive, captchaWidget: true }, "challenge", "captcha"],
    [
      { ...page, title: "Check", textSample: "Verify you are human", textLength: 30 },
      "challenge",
      "verification",
    ],
    [{ ...page, title: "Two-step verification", hasOneTimeCode: true }, "login", "two-factor"],
    [{ ...page, title: "Sign in", hasPassword: true }, "login", "login"],
    [{ ...page, title: "Access denied", textLength: 80 }, "challenge", "blocked"],
  ];
  for (const [snapshot, state, kind] of cases) {
    const result = classifyReadiness(snapshot);
    assert.equal(result.state, state, kind);
    assert.deepEqual(result.gate, { kind, interactive: true });
    const handoff = humanHandoff(result);
    assert.equal(handoff.reason, kind);
    assert.equal(handoff.url, "https://shop.example/");
    assert.equal(handoff.resume, "when-cleared");
    assert.ok(handoff.guidance.length > 10);
  }
});

test("an interactive captcha behind passive wording is never called passive", () => {
  const result = classifyReadiness({
    ...passive,
    textSample: "Just a moment. Press and hold the button.",
  });
  assert.equal(result.gate.interactive, true);
});

test("a ready page or a Chrome error page carries no gate", () => {
  assert.equal(classifyReadiness(page).gate, undefined);
});

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms), slept: () => t };
}

test("a passive interstitial is waited out by polling until the real page loads", async () => {
  const c = clock();
  const pages = [passive, passive, passive, page];
  let clicks = 0;
  const result = await waitOutInterstitial(async () => pages.shift() ?? page, {
    now: c.now,
    sleep: c.sleep,
    intervalMs: 500,
  });
  assert.equal(result.outcome, "cleared");
  assert.equal(result.polls, 4);
  assert.equal(result.waitedMs, 1500);
  assert.equal(result.readiness.state, "ready");
  assert.equal(clicks, 0);
});

test("the wait-out is bounded and reports timeout, not a generic error", async () => {
  const c = clock();
  const result = await waitOutInterstitial(async () => passive, {
    now: c.now,
    sleep: c.sleep,
    timeoutMs: 3000,
    intervalMs: 1000,
  });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.waitedMs, 3000);
  assert.equal(result.polls, 4);
  assert.equal(result.readiness.gate.kind, "interstitial");
});

test("a passive check that turns into a captcha pauses for the user at once", async () => {
  const c = clock();
  const pages = [passive, { ...passive, captchaWidget: true }];
  const result = await waitOutInterstitial(async () => pages.shift() ?? page, c);
  assert.equal(result.outcome, "interactive");
  assert.equal(result.handoff.reason, "captcha");
  assert.equal(result.polls, 2);
});

test("handoff resume: once the user clears the gate the next poll is ready", async () => {
  const c = clock();
  const gate = { ...page, title: "Sign in", hasPassword: true };
  const first = await waitOutInterstitial(async () => gate, c);
  assert.equal(first.outcome, "interactive");
  const resumed = await waitOutInterstitial(async () => page, c);
  assert.equal(resumed.outcome, "cleared");
  assert.equal(resumed.readiness.url, first.handoff.url);
});
