// Captured frames on disk: list a take's frames/ and stage them into the kit's public/frames.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const listFrames = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jpg"))
        .sort()
    : [];

/** Hardlink (else copy) every frame of `from` into `to`, replacing what was there. */
export function stageFrames(from: string, to: string): number {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const names = listFrames(from);
  for (const f of names) {
    try {
      linkSync(join(from, f), join(to, f));
    } catch {
      copyFileSync(join(from, f), join(to, f));
    }
  }
  return names.length;
}
