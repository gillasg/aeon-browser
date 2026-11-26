// `aeon repl` cells write workspace files and upload them like a chat's cells: the daemon answers
// artifact() writes and validateUpload with the session's own workspace, string or array alike.
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cliCall } from "../dist/core-browser.js";

test("a CLI cell's artifact is uploadable from its workspace", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "aeon-cli-ws-")), "workspaces", "s");
  const call = cliCall("external:s", root);
  await call({ workspace: "artifact", name: "a.txt", value: "x" });
  const real = await realpath(join(root, "a.txt"));
  // page.upload('#f', 'a.txt') and page.upload('#f', ['a.txt']) both send an array.
  for (const files of [["a.txt"], [].concat("a.txt")]) {
    const answer = await call({ validateUpload: files });
    assert.ok(Array.isArray(answer));
    assert.deepEqual(answer, [real]);
  }
  await assert.rejects(call({ validateUpload: ["../../x"] }), /UPLOAD_OUTSIDE_WORKSPACE/);
});
