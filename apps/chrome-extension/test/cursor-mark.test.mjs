import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

const wing =
  "M 1.2 1.2 L 23.2 9.2 L 17.2 7.3 L 18.7 10.5 L 13.9 8.8 L 15.1 12 L 11.3 9.7 L 14.2 13 L 10.9 12.3 L 13.4 16.8 L 10 15.9 L 12.9 21.5 Z";

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
  const width = 22 * scale;
  const height = 20 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 25 23"><path d="${wing}" fill="#9fd4ff" stroke="#142033"/></svg>`;
}

test("the flying wing is the same path at 1x and 2x", async () => {
  const mark = await load("../../../browser/packages/engine/src/cursor-mark.ts");
  assert.equal(mark.CURSOR_PATH, wing);
  assert.equal(mark.CURSOR_WIDTH, 22);
  assert.equal(mark.CURSOR_HEIGHT, 20);
  assert.match(svg(1), /width="22" height="20"/);
  assert.match(svg(2), /width="44" height="40"/);
  assert.ok(svg(1).includes(mark.CURSOR_PATH));
  assert.ok(svg(2).includes(mark.CURSOR_PATH));
});

test("glide midpoint matches the bent ease-out", async () => {
  const mark = await load("../../../browser/packages/engine/src/cursor-mark.ts");
  assert.deepEqual(mark.glidePoint(0, 0, 100, 0, 0.5), { x: 87.5, y: 3.9375 });
});

test("the page painter is the one cursor and does not dispatch events", async () => {
  const page = await load("../../../browser/packages/engine/src/cursor-page.ts");
  const source = page.cursorExpression({});
  assert.match(source, /M 1\.2 1\.2/);
  assert.match(source, /\.p\.on \.tr,\.p\.on \.stop\{pointer-events:none\}/);
  assert.equal(source.includes("dispatchEvent"), false);
  assert.equal(source.includes("aeon-cursor-stop"), false);
  assert.equal(source.includes("aeon-cursor-transcript"), false);
});

test("cursor token values are the last ones in tokens.css", async () => {
  const mark = await load("../../../browser/packages/engine/src/cursor-mark.ts");
  const css = await readFile(
    new URL("../../../packages/ui/src/tokens.css", import.meta.url),
    "utf8",
  );
  const values = new Map();
  for (const match of css.matchAll(/(--aeon-[\w-]+)\s*:\s*([^;]+);/g))
    values.set(match[1], match[2].trim());
  for (const [name, value] of Object.entries(mark.CURSOR_VARS))
    assert.equal(values.get(name), value, name);
});
