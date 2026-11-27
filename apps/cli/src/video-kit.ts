// `graft video kit <dir>`: copy the Remotion starter kit out of Graft's templates into a folder the
// agent can install and render. The kit is plain files — Graft never bundles Remotion or renders.
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the kit lives in a checkout and in an installed package. */
export function kitSource(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    fileURLToPath(new URL("../../templates/video", import.meta.url)), // apps/cli/dist -> repo root
    fileURLToPath(new URL("../../../templates/video", import.meta.url)), // dist nested one more
    resolve(here, "..", "templates", "video"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found)
    throw new Error("The video starter kit is missing from this Graft install (templates/video)");
  return found;
}

/** Copy the whole kit into `dir` (created if needed). Existing files are overwritten. */
export async function copyKit(dir: string): Promise<string> {
  const target = resolve(dir);
  const source = kitSource();
  await mkdir(target, { recursive: true });
  const entries = await readdir(source);
  if (!entries.length) throw new Error(`The video starter kit is empty at ${source}`);
  for (const entry of entries)
    await cp(resolve(source, entry), resolve(target, entry), { recursive: true, force: true });
  return target;
}
