import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetStealth,
  injectedScripts,
  judgeStealth,
  noteInjectedScript,
} from "../dist/stealth.js";

test("a clean page has no signals", () => {
  const report = judgeStealth({}, { runtimeEnabled: false, injectedScripts: [] });
  assert.equal(report.detectable, false);
  assert.deepEqual(report.signals, []);
});

test("each observable signal is named", () => {
  const report = judgeStealth(
    {
      webdriver: true,
      globals: ["__graftDemo"],
      overlays: ["#graft-handoff"],
      wrapped: ["window.open"],
      geolocationShim: true,
    },
    { runtimeEnabled: true, injectedScripts: [{ label: "quiet tab", world: "main" }] },
  );
  assert.equal(report.detectable, true);
  assert.equal(report.signals.length, 7);
  assert.match(report.signals.join("\n"), /navigator\.webdriver/);
  assert.match(report.signals.join("\n"), /Runtime domain/);
  assert.match(report.signals.join("\n"), /__graftDemo/);
  assert.match(report.signals.join("\n"), /#graft-handoff/);
  assert.match(report.signals.join("\n"), /window\.open/);
  assert.match(report.signals.join("\n"), /quiet tab/);
  assert.deepEqual(report.diagnostics, []);
});

test("an isolated-world helper is metadata, not a page-visible signal", () => {
  const report = judgeStealth(
    {},
    {
      runtimeEnabled: false,
      injectedScripts: [
        { label: "the settle probe (isolated world)", world: "isolated" },
        { label: "first download: reissue when Chrome drops it", world: "isolated" },
      ],
    },
  );
  assert.equal(report.detectable, false);
  assert.deepEqual(report.signals, []);
  assert.equal(report.diagnostics.length, 2);
  assert.match(report.diagnostics.join("\n"), /isolated-world helper/);
  assert.match(report.diagnostics.join("\n"), /settle probe/);
});

test("queued scripts are cleared with the tab", () => {
  noteInjectedScript(7, "dialogs");
  noteInjectedScript(7, "location");
  assert.deepEqual(
    injectedScripts(7).map((script) => script.label),
    ["dialogs", "location"],
  );
  forgetStealth(7);
  assert.deepEqual(injectedScripts(7), []);
});

test("own properties or symbols on a wrapper are reported", () => {
  const report = judgeStealth(
    { leaks: ["window.open has its own toString", "window has Symbol(browserkit.quiet)"] },
    { runtimeEnabled: false, injectedScripts: [] },
  );
  assert.equal(report.detectable, true);
  assert.match(report.signals.join("\n"), /own toString/);
  assert.match(report.signals.join("\n"), /Symbol\(browserkit\.quiet\)/);
});
