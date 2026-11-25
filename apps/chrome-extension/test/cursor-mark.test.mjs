import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

const wing = "M 1.8 1.8 L 1.8 18.2 L 6.3 13.9 L 13.4 13.9 Z";

async function load(entry) {
  const directory = await mkdtemp(join(tmpdir(), "aeon-mark-"));
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

function svg(scale) {
  const width = 15 * scale;
  const height = 20 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 15 20"><path d="${wing}" fill="#9fd4ff" stroke="#142033"/></svg>`;
}

test("the stemless pointer is the same path at 1x and 2x", async () => {
  const mark = await load("../../../browser/packages/engine/src/cursor-mark.ts");
  assert.equal(mark.CURSOR_PATH, wing);
  assert.equal(mark.CURSOR_WIDTH, 16);
  assert.equal(mark.CURSOR_HEIGHT, 21);
  assert.match(svg(1), /width="15" height="20"/);
  assert.match(svg(2), /width="30" height="40"/);
  assert.ok(svg(1).includes(mark.CURSOR_PATH));
  assert.ok(svg(2).includes(mark.CURSOR_PATH));
});

test("glide midpoint matches the bent ease-out", async () => {
  const mark = await load("../../../browser/packages/engine/src/cursor-mark.ts");
  assert.deepEqual(mark.glidePoint(0, 0, 100, 0, 0.5), { x: 87.5, y: 3.9375 });
});

test("the page painter is the one cursor and dispatches only neutral state events", async () => {
  const page = await load("../../../browser/packages/engine/src/cursor-page.ts");
  const source = page.cursorExpression({});
  assert.match(source, /M 1\.8 1\.8/);
  assert.match(source, /\.p\.on \.tr,\.p\.on \.stop\{pointer-events:none\}/);
  assert.equal(source.includes("aeon-cursor-stop"), false);
  assert.equal(source.includes("aeon-cursor-transcript"), false);
  assert.match(source, /new CustomEvent\(STATE_EVENT/);
});

test("cursor token values are the last ones in tokens.css", async () => {
  const mark = await load("../../../browser/packages/engine/src/cursor-mark.ts");
  const css = await readFile(
    new URL("../../../packages/ui/src/tokens.css", import.meta.url),
    "utf8",
  );
  const values = new Map();
  for (const match of css.matchAll(/(--aeon-[\w-]+)\s*:\s*([^;]+);/g))
    values.set(match[1], match[2].replace(/\s+/g, " ").trim());
  for (const [name, value] of Object.entries(mark.CURSOR_VARS))
    assert.equal(values.get(name), value, name);
});
