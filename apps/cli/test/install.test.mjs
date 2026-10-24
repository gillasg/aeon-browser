import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install } from "../dist/install.js";

async function browserkitSkill(root) {
  const folder = join(root, "browserkit", "skills", "browserkit");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: browserkit\ndescription: browser control\n---\n\n# browserkit\n",
  );
  return folder;
}

async function withHome(root, run) {
  const previous = {
    home: process.env.HOME,
    profile: process.env.USERPROFILE,
    appdata: process.env.APPDATA,
  };
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.APPDATA = join(root, "appdata");
  try {
    return await run();
  } finally {
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.profile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.profile;
    if (previous.appdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous.appdata;
  }
}

test("install removes a linked browserkit skill and leaves a real folder alone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = join(root, ".agents", "skills");
  await mkdir(shared, { recursive: true });

  // A link to browserkit's skill is replaced by Aeon's (never a real folder).
  const linked = await browserkitSkill(join(root, "one"));
  await symlink(
    linked,
    join(shared, "browserkit"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await withHome(root, install);
  await assert.rejects(() => lstat(join(shared, "browserkit")), /ENOENT/);
  assert.equal((await lstat(join(shared, "aeon"))).isSymbolicLink(), true);

  // A real browserkit folder is somebody's work: install must not delete it.
  const real = join(root, "two", ".agents", "skills", "browserkit");
  await mkdir(real, { recursive: true });
  await writeFile(join(real, "SKILL.md"), "---\nname: browserkit\ndescription: mine\n---\n");
  await withHome(join(root, "two"), install);
  assert.equal(
    (await readFile(join(real, "SKILL.md"), "utf8")).includes("description: mine"),
    true,
  );
  assert.equal((await lstat(real)).isDirectory(), true);
});
