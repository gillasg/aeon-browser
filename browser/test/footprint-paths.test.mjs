import assert from "node:assert/strict";
import test from "node:test";
import { createPortable } from "../scripts/footprint-paths.mjs";

test("a Windows checkout path is substituted inside stringified tools", () => {
  const root = String.raw`C:\Users\dev\AppData\Local\Temp\graft-footprint-abc123`;
  const graft = String.raw`C:\Users\dev\graft-browser`;
  const portable = createPortable([
    [root, "<workspace>"],
    [graft, "<graft>"],
  ]);
  const text = JSON.stringify({
    cwd: root + String.raw`\workspace`,
    repo: graft,
    note: "keep this",
  });
  const out = portable(text);
  assert.equal(out.includes("C:"), false);
  assert.equal(out.includes(root), false);
  assert.equal(out.includes(graft), false);
  assert.deepEqual(JSON.parse(out), {
    cwd: String.raw`<workspace>\workspace`,
    repo: "<graft>",
    note: "keep this",
  });
});

test("POSIX and plain-text paths keep working", () => {
  const root = "/tmp/graft footprint abc";
  const graft = "/home/dev/code/graft/graft-browser";
  const portable = createPortable([
    [root, "<workspace>"],
    [graft, "<graft>"],
  ]);
  assert.equal(
    portable(`${root}/workspace and ${graft}/packages/pi-adapter`),
    "<workspace>/workspace and <graft>/packages/pi-adapter",
  );
});
