// The orb is Graft's own overlay: its host carries data-ux-overlay, which the engine leaves out of the
// page state the agent reads (browser/packages/engine/src/native-browser-overlay.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the orb host is marked data-ux-overlay as well as data-ux-orb", async () => {
  const source = await readFile(new URL("../src/orb/orb-overlay.ts", import.meta.url), "utf8");
  assert.match(source, /this\.host\.setAttribute\("data-ux-orb", ""\);/);
  assert.match(source, /this\.host\.setAttribute\("data-ux-overlay", ""\);/);
});
