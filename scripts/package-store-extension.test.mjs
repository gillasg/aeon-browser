import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  packageStore,
  storeFiles,
  validateStoreManifest,
  validateWelcomePage,
} from "./package-store-extension.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(root, "apps/chrome-extension/manifest.native.json"), "utf8"),
);
const welcome = readFileSync(join(root, "apps/chrome-extension/welcome.html"), "utf8");

test("the shipped manifest passes the store checks", () => {
  assert.deepEqual(validateStoreManifest(manifest), []);
});

test("store checks catch long descriptions, broad hosts and static resource urls", () => {
  const errors = validateStoreManifest({
    ...manifest,
    description: "x".repeat(133),
    host_permissions: ["<all_urls>"],
    web_accessible_resources: [{ resources: ["a.html"], matches: ["https://*/*"] }],
  });
  assert.equal(errors.length, 3);
});

test("the welcome page stays on the void and prints only published commands", () => {
  assert.deepEqual(validateWelcomePage(welcome), []);
  assert.match(welcome, /Every site you're signed in to becomes an API your agent can call\./);
  assert.match(welcome, /aeon map --attach active --until-idle 8/);
  assert.match(welcome, /aeon mcp/);
  assert.doesNotMatch(welcome, /vault/i);
  assert.ok(validateWelcomePage(["<p>npx", "aeon</p>"].join(" ")).length >= 2);
});

test("packaging is reproducible, drops maps and the dev key", () => {
  const dir = mkdtempSync(join(tmpdir(), "aeon-store-"));
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "nested"), { recursive: true });
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dist, "welcome.html"), welcome);
  writeFileSync(join(dist, "nested", "a.js"), "1");
  writeFileSync(join(dist, "nested", "a.js.map"), "{}");
  assert.deepEqual(storeFiles(dist), ["manifest.json", "nested/a.js", "welcome.html"]);
  const one = packageStore(dist, join(dir, "one.zip"));
  const two = packageStore(dist, join(dir, "two.zip"));
  assert.equal(one.ok, true);
  assert.equal(one.manifest.key, undefined);
  assert.deepEqual(readFileSync(join(dir, "one.zip")), readFileSync(join(dir, "two.zip")));
  assert.equal(two.files, 3);
});
