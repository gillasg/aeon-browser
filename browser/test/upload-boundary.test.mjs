// Upload sources stay inside the workspace: an absolute host path, a ../ walk and a symlink that
// leads out are refused, so a page cannot talk the agent into attaching a key or a config file.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateUploadFiles } from "../apps/bridge/dist/workspace.js";

test("uploads resolve only to files inside the workspace", async () => {
  const base = await mkdtemp(join(tmpdir(), "graft-upload-"));
  const ws = join(base, "ws");
  await mkdir(join(ws, "in"), { recursive: true });
  await writeFile(join(ws, "in", "ok.txt"), "ok");
  await writeFile(join(base, "outside"), "secret");
  await symlink("/etc/hosts", join(ws, "hosts-link"));
  await symlink(join(base, "outside"), join(ws, "out-link"));
  try {
    for (const file of ["/etc/hosts", "../outside", "hosts-link", "out-link", "in/../../outside"])
      await assert.rejects(validateUploadFiles([file], ws), /UPLOAD_OUTSIDE_WORKSPACE/, file);
    const [ok] = await validateUploadFiles(["in/ok.txt"], ws);
    assert.match(ok, /in[\\/]ok\.txt$/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
