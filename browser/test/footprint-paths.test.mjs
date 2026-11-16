import assert from "node:assert/strict";
import test from "node:test";
import { createPortable } from "../scripts/footprint-paths.mjs";

test("a Windows checkout path is substituted inside stringified tools", () => {
  const root = String.raw`C:\Users\dev\AppData\Local\Temp\aeon-footprint-abc123`;
  const aeon = String.raw`C:\Users\dev\aeon-browser`;
  const portable = createPortable([
    [root, "<workspace>"],
    [aeon, "<aeon>"],
  ]);
  const text = JSON.stringify({
    cwd: root + String.raw`\workspace`,
    repo: aeon,
    note: "keep this",
  });
  const out = portable(text);
  assert.equal(out.includes("C:"), false);
  assert.equal(out.includes(root), false);
  assert.equal(out.includes(aeon), false);
  assert.deepEqual(JSON.parse(out), {
    cwd: String.raw`<workspace>\workspace`,
    repo: "<aeon>",
    note: "keep this",
  });
});

test("POSIX and plain-text paths keep working", () => {
  const root = "/tmp/aeon footprint abc";
  const aeon = "/home/dev/code/aeon/aeon-browser";
  const portable = createPortable([
    [root, "<workspace>"],
    [aeon, "<aeon>"],
  ]);
  assert.equal(
    portable(`${root}/workspace and ${aeon}/packages/pi-adapter`),
    "<workspace>/workspace and <aeon>/packages/pi-adapter",
  );
});
