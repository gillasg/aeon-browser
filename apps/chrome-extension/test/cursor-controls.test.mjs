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
  const overlay = await readFile(join(repo, "browser/packages/engine/src/cursor-page.ts"), "utf8");
  assert.match(overlay, /dataset\.aeonControls/);
  assert.match(overlay, /\.p\.on \.tr,\.p\.on \.stop\{pointer-events:none\}/);
  assert.equal(overlay.includes("dispatchEvent"), false);
  assert.equal(overlay.includes("aeon-cursor-stop"), false);
  assert.equal(overlay.includes("aeon-cursor-transcript"), false);
});

test("the buttons mount only while the pill shows them, then leave the page", async () => {
  const controls = await load("../src/orb/cursor-controls.ts");
  assert.equal(controls.controlsToShow(undefined), null);
  assert.equal(controls.controlsToShow(JSON.stringify({ tr: null, stop: null })), null);
  assert.equal(
    controls.controlsToShow(JSON.stringify({ tr: null, stop: { x: 1, y: 2, w: 0, h: 9 } })),
    null,
  );

  const dom = fakePage();
  const sent = [];
  controls.startCursorControls(
    (kind) => sent.push(kind),
    () => false,
  );
  const controlHosts = () =>
    dom.documentElement.children.filter((node) => node.id === "aeon-cursor-controls");
  // Nothing is on screen: no host, no buttons, nothing appended.
  assert.deepEqual(controlHosts(), []);

  dom.cursor.dataset.aeonControls = JSON.stringify({
    tr: { x: 4, y: 5, w: 24, h: 24 },
    stop: null,
  });
  dom.mutated();
  const host = controlHosts()[0];
  assert.ok(host, "the buttons did not mount with a pill box on screen");
  assert.equal(host.shadow.children.length, 3);
  const [style, transcript, stop] = host.shadow.children;
  assert.equal(style.tagName, "STYLE");
  assert.equal(transcript.hidden, false);
  assert.equal(transcript.style.left, "4px");
  assert.equal(stop.hidden, true);
  transcript.listeners.click({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(sent, ["aeon.cursor.transcript"]);

  dom.cursor.dataset.aeonControls = JSON.stringify({ tr: null, stop: null });
  dom.mutated();
  assert.deepEqual(controlHosts(), [], "the buttons stayed after the pill went away");
});

/** The few DOM pieces cursor-controls.ts touches, with observers the test can fire by hand. */
function fakePage() {
  observers.length = 0;
  const documentElement = new FakeNode("html");
  const cursor = new FakeNode("div");
  cursor.id = "aeon-agent-cursor";
  documentElement.append(cursor);
  globalThis.document = {
    documentElement,
    createElement: (tag) => new FakeNode(tag),
    getElementById: (id) => byId(documentElement, id),
  };
  globalThis.MutationObserver = FakeObserver;
  return {
    documentElement,
    cursor,
    mutated: () => {
      for (const observer of observers) observer.callback([], observer);
    },
  };
}

const observers = [];

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.id = "";
    this.dataset = {};
    this.style = { cssText: "" };
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.hidden = false;
    this.attributes = {};
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(kind, fn) {
    this.listeners[kind] = fn;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  attachShadow() {
    this.shadow = new FakeNode("shadow");
    return this.shadow;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
}

class FakeObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  disconnect() {}
}

function byId(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = byId(child, id);
    if (hit) return hit;
  }
  return undefined;
}
