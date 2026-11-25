import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = { debugger: { sendCommand: async () => ({}) } };
const {
  detectVendors,
  kinematicsFromStart,
  armVendorKinematics,
  setBreakerProbe,
  setVendorKinematicsOptOut,
} = await import("../dist/antibot-vendors.js");
const { humanOn, forgetHumanInput } = await import("../dist/native-browser-human-input.js");
const { classifyReadiness } = await import("../dist/readiness.js");

const markers = [
  ["cloudflare", { scripts: ["https://challenges.cloudflare.com/turnstile/v0/api.js"] }],
  ["cloudflare", { cookies: "a=1; cf_clearance=xyz" }],
  ["datadome", { cookies: "datadome=abc" }],
  ["perimeterx", { cookies: ["_px3"] }],
  ["akamai", { cookies: "_abck=1~0; bm_sz=2" }],
  ["kasada", { scripts: ["https://shop.example/149e9513-01fa/ips.js?x=1"] }],
  ["kasada", { headers: { "x-kpsdk-ct": "t" } }],
];

test("ST-4: each vendor marker turns human kinematics on from action 1", () => {
  let tab = 100;
  for (const [vendor, signals] of markers) {
    const vendors = detectVendors(signals);
    assert.deepEqual(vendors, [vendor], JSON.stringify(signals));
    tab++;
    assert.equal(humanOn(tab), false);
    const choice = armVendorKinematics(tab, { url: "https://shop.example/", vendors });
    assert.equal(choice.human, true);
    assert.equal(choice.reason, "vendor");
    assert.equal(humanOn(tab), true, `${vendor} arms the tab before any challenge`);
    forgetHumanInput(tab);
  }
});

test("ST-4: a plain page stays on the fast path", () => {
  assert.deepEqual(detectVendors({ cookies: "session=1; theme=dark", scripts: ["/app.js"] }), []);
  assert.equal(armVendorKinematics(200, { url: "https://plain.example/" }).human, false);
  assert.equal(humanOn(200), false);
});

test("ST-4: a tripped breaker arms kinematics with no marker on the page", () => {
  setBreakerProbe((origin) => origin === "https://walled.example");
  assert.equal(armVendorKinematics(201, { url: "https://walled.example/a" }).reason, "breaker");
  assert.equal(humanOn(201), true);
  assert.equal(armVendorKinematics(202, { url: "https://other.example/" }).human, false);
  setBreakerProbe();
  forgetHumanInput(201);
});

test("ST-4: an explicit opt-out keeps the fast path", () => {
  assert.equal(kinematicsFromStart({ vendors: ["datadome"], optOut: true }).human, false);
  setVendorKinematicsOptOut(true);
  assert.equal(
    armVendorKinematics(203, { url: "https://x.example/", vendors: ["akamai"] }).human,
    false,
  );
  assert.equal(humanOn(203), false);
  setVendorKinematicsOptOut(false);
});

test("readiness carries vendor markers from the page snapshot", () => {
  const ready = classifyReadiness({
    readyState: "complete",
    title: "Shop",
    textSample: "Lots of products here ".repeat(40),
    textLength: 800,
    main: true,
    links: 30,
    cookies: "datadome=1",
    scripts: ["https://shop.example/app.js"],
  });
  assert.deepEqual(ready.vendors, ["datadome"]);
  assert.equal(classifyReadiness({ title: "x", textSample: "y" }).vendors, undefined);
});
