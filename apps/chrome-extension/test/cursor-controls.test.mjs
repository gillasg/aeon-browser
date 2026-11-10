import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

const app = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

async function load(entry) {
  const directory = await mkdtemp(join(tmpdir(), "aeon-cursor-"));
  const outfile = join(directory, "bundle.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

test("an untrusted cursor click is ignored and a huge hit box is rejected", async () => {
  const controls = await load("../src/orb/cursor-controls.ts");
  assert.equal(controls.acceptCursorClick({ isTrusted: false }), false);
  assert.equal(controls.acceptCursorClick({ isTrusted: true }), true);
  assert.equal(controls.controlKind("transcript", true), "aeon.cursor.transcript");
  assert.equal(controls.controlKind("stop", true), "aeon.cursor.stop");
  assert.equal(controls.controlKind("stop", false), "aeon.cursor.transcript");
  const raw = JSON.stringify({
    tr: { x: 1, y: 2, w: 24, h: 24 },
    stop: { x: 0, y: 0, w: 400, h: 400 },
  });
  assert.deepEqual(controls.parseControls(raw), {
    tr: { x: 1, y: 2, w: 24, h: 24 },
    stop: null,
  });
  assert.equal(controls.parseControls("not json"), null);
  assert.equal(controls.parseControls("x".repeat(401)), null);
});

test("chat stays in the extension and orb.html is the only dynamic web resource", async () => {
  const manifest = JSON.parse(await readFile(join(app, "manifest.native.json"), "utf8"));
  const resources = manifest.web_accessible_resources;
  assert.equal(resources.length, 1);
  assert.deepEqual(resources[0].resources, ["orb.html"]);
  assert.equal(resources[0].use_dynamic_url, true);
  assert.equal(JSON.stringify(resources).includes("chat.html"), false);
  const frame = await load("../src/extension-frame.ts");
  const page = { location: { origin: "chrome-extension://aeon" } };
  page.parent = page;
  globalThis.window = page;
  assert.equal(frame.framedByExtension(), true);
  assert.equal(frame.framedInPage(), false);
  page.parent = { location: { origin: "https://evil.example" } };
  assert.equal(frame.framedByExtension(), false);
  assert.equal(frame.framedInPage(), true);
  page.parent = page;
  assert.equal(frame.isOrbPath("/orb.html"), true);
  assert.equal(frame.isOrbPath("/session-token/orb.html"), true);
  assert.equal(frame.isOrbPath("/a/b/orb.html"), false);
});

test("the page cursor publishes button boxes and does not dispatch cursor events", async () => {
  const overlay = await readFile(
    join(repo, "browser/packages/engine/src/native-browser-cursor.ts"),
    "utf8",
  );
  assert.match(overlay, /dataset\.aeonControls/);
  assert.match(overlay, /\.p\.on \.tr,\.p\.on \.stop\{pointer-events:none\}/);
  assert.equal(overlay.includes("dispatchEvent"), false);
  assert.equal(overlay.includes("aeon-cursor-stop"), false);
  assert.equal(overlay.includes("aeon-cursor-transcript"), false);
});
