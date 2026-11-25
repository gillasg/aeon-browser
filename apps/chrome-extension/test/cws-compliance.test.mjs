// Chrome Web Store rules for both extensions (Aeon and browserkit): MV3, no sandbox pages, no
// unsafe-eval, unsafe-inline or remote origins in the CSP, no code-sandbox artifact in a build,
// no eval or new Function in a built bundle, and a written reason for every permission.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const reasons = read("apps/chrome-extension/permission-justifications.json");
const MANIFESTS = [
  {
    manifest: "apps/chrome-extension/manifest.native.json",
    dist: "apps/chrome-extension/native-dist",
  },
  { manifest: "browser/apps/extension/manifest.json", dist: "browser/apps/extension/build" },
];

const STORE_OPTIONAL = [
  "history",
  "bookmarks",
  "clipboardRead",
  "contentSettings",
  "privacy",
  "tabCapture",
];

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function cspValues(manifest) {
  const csp = manifest.content_security_policy;
  if (!csp) return [];
  return typeof csp === "string" ? [csp] : Object.values(csp).map(String);
}

for (const { manifest: path, dist } of MANIFESTS) {
  const manifest = read(path);

  test(`${path}: MV3 with no sandbox pages and a strict CSP`, () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.sandbox, undefined, "no sandbox pages");
    for (const policy of cspValues(manifest)) {
      assert.doesNotMatch(policy, /unsafe-eval|unsafe-inline|wasm-unsafe-eval/);
      assert.doesNotMatch(policy, /https?:\/\/|\*/, "no remote origins");
    }
  });

  test(`${path}: every permission has a written reason`, () => {
    const declared = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
      ...(manifest.host_permissions ?? []).map((host) => `host_permissions:${host}`),
      ...(manifest.optional_host_permissions ?? []).map((host) => `host_permissions:${host}`),
    ];
    for (const permission of declared)
      assert.ok(reasons[permission]?.length > 20, `${permission} needs a justification`);
  });

  test(`${path}: sensitive permissions are optional and asked for on use`, () => {
    for (const permission of STORE_OPTIONAL) {
      assert.ok(!manifest.permissions?.includes(permission), `${permission} is not install-time`);
      assert.ok(manifest.optional_permissions?.includes(permission), `${permission} is optional`);
    }
    assert.ok(manifest.description.length <= 132, "store descriptions fit 132 characters");
  });

  test(`${path}: the build has no code sandbox and evaluates no strings`, () => {
    const built = files(join(root, dist));
    if (!built.length) return;
    assert.ok(!built.some((file) => /code-sandbox/.test(file)), "no code-sandbox artifact");
    for (const file of built.filter((name) => name.endsWith(".html")))
      assert.doesNotMatch(readFileSync(file, "utf8"), /code-sandbox/);
    const builtManifest = JSON.parse(readFileSync(join(root, dist, "manifest.json"), "utf8"));
    assert.equal(builtManifest.sandbox, undefined);
    for (const file of built.filter((name) => name.endsWith(".js"))) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /\bnew Function\s*\(/, `${file} builds a function from a string`);
      assert.doesNotMatch(source, /\(0,\s*eval\)|[^.\w$]eval\s*\(/, `${file} calls eval`);
    }
  });
}

test("the justification table names no permission that no manifest declares", () => {
  const all = new Set();
  for (const { manifest: path } of MANIFESTS) {
    const manifest = read(path);
    for (const permission of manifest.permissions ?? []) all.add(permission);
    for (const permission of manifest.optional_permissions ?? []) all.add(permission);
    for (const host of manifest.host_permissions ?? []) all.add(`host_permissions:${host}`);
  }
  for (const permission of Object.keys(reasons)) assert.ok(all.has(permission), permission);
});
