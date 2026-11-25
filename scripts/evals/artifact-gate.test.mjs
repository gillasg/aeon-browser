import assert from "node:assert/strict";
import test from "node:test";
import {
  diffPermissionSet,
  runArtifactGate,
  scanForSecrets,
  validateManifest,
} from "./artifact-gate.mjs";

test("diffPermissionSet flags unapproved and stale permissions", () => {
  const diff = diffPermissionSet(["tabs", "management"], ["tabs", "storage"]);
  assert.deepEqual(diff.unapproved, ["management"]);
  assert.deepEqual(diff.stale, ["storage"]);
});

test("validateManifest rejects unapproved permissions and forbidden host patterns", () => {
  const policy = { permissions: ["tabs"], host_permissions: ["https://*/*"] };
  const errors = validateManifest(
    { permissions: ["tabs", "power"], host_permissions: ["<all_urls>"] },
    policy,
    ["<all_urls>"],
  );
  assert.ok(errors.some((e) => e.includes("unapproved permissions: power")));
  assert.ok(errors.some((e) => e.includes("forbidden host_permission: <all_urls>")));
});

test("scanForSecrets detects leaked token prefixes and ignores clean content", () => {
  assert.deepEqual(scanForSecrets("const key = 'normal-config-value';"), []);
  const antSample = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz1234"].join("-");
  const ghSample = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  assert.deepEqual(scanForSecrets(antSample), ["anthropic-key"]);
  assert.deepEqual(scanForSecrets(ghSample), ["github-token"]);
});

test("real repo extension manifests pass the permission allowlist gate", async () => {
  const report = await runArtifactGate({ skipArtifacts: true });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.manifests.length, 2);
});
