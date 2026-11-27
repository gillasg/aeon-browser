// The orb is Graft's own overlay: its host carries data-graft-overlay, which the engine leaves out of the
// page state the agent reads (browser/packages/engine/src/native-browser-overlay.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the orb host is marked data-graft-overlay as well as data-graft-orb", async () => {
  const source = await readFile(new URL("../src/orb/orb-overlay.ts", import.meta.url), "utf8");
  assert.match(source, /this\.host\.setAttribute\("data-graft-orb", ""\);/);
  assert.match(source, /this\.host\.setAttribute\("data-graft-overlay", ""\);/);
});
