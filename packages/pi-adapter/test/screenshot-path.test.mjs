import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatCell } from "../dist/cell-grammar.js";
import { noteWorkspaceStep, workspaceCall } from "../dist/browser-workspace.js";

const png = Buffer.from("hi").toString("base64");

function shot(name, value = png) {
  return { workspace: "screenshot", name, value, base64: true };
}

/** workspacePath returns a realpath, which drops a temp symlink such as macOS /var or a Windows 8.3 name. */
async function samePath(actual, expected) {
  assert.equal(await realpath(actual), await realpath(expected));
}

test("screenshot paths stay inside the session or the temp directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graft-shot-"));
  const other = await mkdtemp(join(tmpdir(), "graft-shot-tmp-"));
  const denied = "/workspace-denied/graft-w61/full.png";
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm("/workspace-denied/graft-w61", { recursive: true, force: true });
    await rm("/workspace-denied/graft-w61-out", { recursive: true, force: true });
  });

  const relative = await workspaceCall(root, shot("r0.png"));
  await samePath(relative.path, join(root, "screens", "r0.png"));
  await assert.rejects(stat(join(root, "r0.png")));
  const nested = await workspaceCall(root, shot("screens/nested.png"));
  await samePath(nested.path, join(root, "screens", "nested.png"));
  await assert.rejects(stat(join(root, "screens", "screens", "nested.png")));

  const kept = join(root, "keep", "full.png");
  const inside = await workspaceCall(root, shot(kept));
  assert.equal(inside.path, kept);
  assert.equal(await readFile(kept, "utf8"), "hi");

  const tempFile = join(other, "full.png");
  const temp = await workspaceCall(root, shot(tempFile));
  assert.equal(temp.path, tempFile);
  assert.equal(await readFile(tempFile, "utf8"), "hi");

  const outside = await workspaceCall(root, shot(denied));
  await samePath(outside.path, join(root, "screens", "full.png"));
  assert.match(outside.note, /outside the session folder and the temp directory/);
  await assert.rejects(stat(denied));

  await assert.rejects(
    () => workspaceCall(root, shot("../secret.png")),
    /File is outside the workspace/,
  );
  await assert.rejects(
    () => workspaceCall(root, { workspace: "artifact", name: tempFile, value: "no" }),
    /relative workspace filename/,
  );
});

test("a screenshot through a symlink that leaves the temp directory is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graft-shot-link-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm("/workspace-denied/graft-w61-out", { recursive: true, force: true });
  });
  try {
    await symlink("/workspace-denied/graft-w61-out", join(root, "escape"));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "ENOTSUP") {
      t.skip("this machine cannot create symlinks");
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => workspaceCall(root, shot(join(root, "escape", "full.png"))),
    /Workspace symlink escapes its root/,
  );
  await assert.rejects(stat("/workspace-denied/graft-w61-out/full.png"));
});

test("screenshot chunks append and the cell says where the file went", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graft-shot-chunk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "keep", "chunks.bin");
  const first = await workspaceCall(root, shot(file, "YWI="));
  const second = await workspaceCall(root, {
    workspace: "screenshot-append",
    name: file,
    value: "Yw==",
    base64: true,
  });
  assert.equal(first.path, file);
  assert.equal(second.path, file);
  assert.equal(await readFile(file, "utf8"), "abc");

  const steps = [];
  noteWorkspaceStep(steps, { workspace: "screenshot" }, { path: "/tmp/x/full.png", bytes: 3 });
  noteWorkspaceStep(
    steps,
    { workspace: "screenshot-append" },
    { path: "/tmp/x/full.png", bytes: 1 },
  );
  const text = formatCell({ steps, output: "", startedAt: 0 });
  assert.match(text, /\[did\] screenshot \/tmp\/x\/full\.png/);
  assert.equal(text.match(/\[did\]/g)?.length, 1);
});
