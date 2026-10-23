import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { chmod, mkdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// aeon install: puts an `aeon` command on the PATH and links the Aeon skill where agents look for
// skills (~/.agents/skills, and ~/.claude/skills unless it already links there), so every agent on
// this machine knows Aeon exists and how to use it. Safe to run again.

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const skill = resolve(dirname(cli), "..", "..", "..", "skills", "aeon");

function binDirectory(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    const npm = join(process.env.APPDATA, "npm");
    if ((process.env.PATH ?? "").toLowerCase().includes(npm.toLowerCase())) return npm;
  }
  return join(homedir(), ".local", "bin");
}

async function installCommand(): Promise<string> {
  const folder = binDirectory();
  await mkdir(folder, { recursive: true });
  const node = process.execPath;
  if (process.platform === "win32")
    await writeFile(join(folder, "aeon.cmd"), `@"${node}" "${cli}" %*\r\n`);
  const shell = join(folder, "aeon");
  await writeFile(
    shell,
    `#!/bin/sh\nexec "${node.replace(/\\/g, "/")}" "${cli.replace(/\\/g, "/")}" "$@"\n`,
  );
  await chmod(shell, 0o755).catch(() => undefined);
  return folder;
}

/** Where the link already points, or undefined when nothing is there. */
function linkTarget(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
  } catch {
    return undefined;
  }
}

/** Links folder/aeon to source, replacing an older link (never a real folder someone made). */
async function linkSkill(folder: string, source: string): Promise<string | undefined> {
  // A skills folder that is itself a link (to ~/.agents/skills) already has the skill.
  const own = linkTarget(folder);
  if (own !== undefined && own !== folder) return undefined;
  const target = join(folder, "aeon");
  const current = linkTarget(target);
  if (current !== undefined && current !== target) await unlink(target).catch(() => rmdir(target));
  else if (current === target)
    throw new Error(`${target} exists and is not a link; remove it first`);
  await mkdir(folder, { recursive: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  return target;
}

export async function install(): Promise<number> {
  if (!existsSync(join(skill, "SKILL.md")))
    throw new Error(`The Aeon skill is missing at ${skill}`);
  const bin = await installCommand();
  process.stdout.write(`Installed the aeon command in ${bin}\n`);
  const shared = join(homedir(), ".agents", "skills");
  const agents = await linkSkill(shared, skill);
  // Claude Code reads ~/.claude/skills: link it to the shared copy.
  const claude = await linkSkill(join(homedir(), ".claude", "skills"), join(shared, "aeon"));
  for (const path of [agents, claude])
    if (path) process.stdout.write(`Linked the Aeon skill at ${path}\n`);
  process.stdout.write("Agents started from now on see the skill. Try: aeon tools\n");
  return 0;
}
