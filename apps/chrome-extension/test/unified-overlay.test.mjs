import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

async function mark() {
  const directory = await mkdtemp(join(tmpdir(), "graft-unified-"));
  const outfile = join(directory, "bundle.mjs");
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../../browser/packages/engine/src/cursor-mark.ts", import.meta.url),
      ),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

test("the extension overlay is the one marked overlay, hidden from the accessibility tree", async () => {
  const source = await read("../src/orb/orb-overlay.ts");
  assert.match(source, /setAttribute\(UNIFIED_OVERLAY_ATTR, "true"\)/);
  assert.match(source, /setAttribute\("aria-hidden", "true"\)/);
  assert.doesNotMatch(source, /aria-modal|\.inert\s*=|setAttribute\("inert"/);
  const { UNIFIED_OVERLAY_ATTR } = await mark();
  assert.equal(UNIFIED_OVERLAY_ATTR, "data-graft-overlay");
});

test("the page painter never shows a second pill beside the extension overlay", async () => {
  const page = await read("../../../browser/packages/engine/src/cursor-page.ts");
  assert.match(page, /\.orb \.p\{display:none!important\}/);
  assert.match(page, /querySelector\(ORB_SELECTOR\)/);
  assert.match(page, /CAPTION_EVENT/);
  const overlay = await read("../src/orb/orb-overlay.ts");
  // The overlay pill stays up while the agent acts and takes the painter's caption.
  assert.doesNotMatch(overlay, /this\.label !== "" && !this\.acting/);
  assert.match(overlay, /addEventListener\(CURSOR_CAPTION_EVENT/);
});

test("the working overlay comes back after back/forward navigation", async () => {
  const content = await read("../src/orb/orb-content.ts");
  assert.match(content, /addEventListener\("pageshow"/);
  assert.match(content, /ORB_RESTORE/);
});

test("the working pill dodges a target within 48px and stays put when clear", async () => {
  const { pillDodge } = await mark();
  const view = { w: 1280, h: 800 };
  const pill = { x: 40, y: 700, w: 200, h: 34 };
  assert.equal(pillDodge(pill, { x: 600, y: 300 }, view), "");
  assert.equal(pillDodge(pill, { x: 120, y: 690 }, view), "top-right");
  assert.equal(pillDodge(pill, { x: 260, y: 650, w: 10, h: 10 }, view), "top-right");
  const top = { x: 1000, y: 20, w: 200, h: 34 };
  assert.equal(pillDodge(top, { x: 1100, y: 40, w: 160, h: 40 }, view), "bottom-left");
  assert.equal(pillDodge(pill, { x: 300, y: 700 }, view, 10), "");
});

test("only the pill's controls take clicks; the pill itself lets them through", async () => {
  const style = await read("../src/orb/orb-overlay-style.ts");
  assert.match(style, /\.pill \{[^}]*pointer-events: none/);
  assert.match(style, /\.pill \.label, \.pill \.ic \{ pointer-events: auto; \}/);
});

test("the box has a dark scheme and dark scrollbars", async () => {
  const css = await read("../orb.css");
  const island = css.slice(css.indexOf(".island {"), css.indexOf("}", css.indexOf(".island {")));
  assert.match(island, /color-scheme: dark/);
  assert.match(island, /scrollbar-width: thin/);
  assert.match(island, /scrollbar-color: var\(--graft-island-line-strong\) transparent/);
  assert.match(css, /::-webkit-scrollbar-thumb \{[^}]*var\(--graft-island-line-strong\)/);
  assert.match(css, /::-webkit-scrollbar-track/);
});

test("the preview tile is a fixed, clipped box that hides a missing image", async () => {
  const css = await read("../orb.css");
  const thumb = css.slice(css.indexOf(".graft-preview-thumb {"));
  assert.match(thumb.slice(0, thumb.indexOf("}")), /overflow: hidden/);
  assert.match(thumb.slice(0, thumb.indexOf("}")), /height: 28px/);
  assert.match(css, /\.graft-browser-preview img \{[^}]*object-fit: cover/);
  assert.match(
    css,
    /img:not\(\[src\]\),\s*\.graft-browser-preview img\[src=""\] \{\s*visibility: hidden/,
  );
});
