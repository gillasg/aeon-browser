// Hermetic real-Chrome stealth probe: drives Graft's built engine, bridge, and extension against
// a local loopback detector page and fails on any unpinned automation/CDP tell or stale pin.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { launchHarness, missingPrerequisite } from "../conformance/harness.mjs";
import { evaluateStealthSnapshot, knownTells } from "./known-tells.mjs";
import { startProbeServer } from "./site.mjs";

const missing = missingPrerequisite();
const required = process.env.GRAFT_STEALTH_REQUIRE === "chrome";

test("hermetic real-Chrome stealth probe", { timeout: 120_000 }, async (t) => {
  if (missing) {
    if (required) assert.fail(`Stealth probe requires Chrome: ${missing}`);
    t.skip(missing);
    return;
  }

  const server = await startProbeServer();
  const harness = await launchHarness();
  try {
    const code = `
      const page = await browser.openTab(${JSON.stringify(server.url)});
      await page.click("#target-btn");
      await page.fill("#target-input", "hello graft");
      return await page.evaluate(() => window.__probeSnapshot());
    `;
    const reply = await harness.run(code, "stealth-probe");
    assert.equal(reply.error, undefined, `engine cell failed: ${JSON.stringify(reply.error)}`);
    const snapshot = reply.value;
    assert.ok(snapshot && typeof snapshot === "object", "missing probe snapshot");

    const verdict = evaluateStealthSnapshot(snapshot, knownTells);
    const outPath = process.env.GRAFT_STEALTH_PROBE_OUT;
    if (outPath) {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(
        outPath,
        JSON.stringify({ chromeVersion: harness.chromeVersion, snapshot, verdict }, null, 2),
      );
    }

    assert.deepEqual(
      verdict.unpinnedFailures,
      [],
      `Unpinned stealth tells detected:\n${JSON.stringify({ failures: verdict.unpinnedFailures, snapshot }, null, 2)}`,
    );
    assert.deepEqual(
      verdict.stalePins,
      [],
      `Stale stealth pins (these checks now pass — remove their pins):\n${JSON.stringify(verdict.stalePins, null, 2)}`,
    );
  } finally {
    await harness.close();
    await server.close();
  }
});
