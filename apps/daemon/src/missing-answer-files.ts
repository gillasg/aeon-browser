import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// An answer that points at a file the run did not leave in the workspace. Reported as one
// notice, never by blocking the answer. Only local markdown links and backtick names count.

const LINK = /\]\(<?([^)\s>]+)>?\)/g;
const TICK = /`([^`\n]+)`/g;
const REMOTE = /^(?:[a-z][\w+.-]*:|#|\/\/)/i;
const EXT =
  /\.(?:md|markdown|csv|json|jsonl|txt|tsv|xlsx|xls|html|htm|zip|pdf|png|jpe?g|webp|gif|svg)$/i;

/** Local files named by the answer that are in none of `roots` (the workspace and its downloads/). */
export function missingAnswerFiles(answer: string, roots: readonly string[]): string[] {
  if (!answer.trim() || roots.length === 0) return [];
  const prose = answer.replace(/```[\s\S]*?```/g, " ");
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of prose.matchAll(LINK)) note(found, seen, match[1], roots);
  for (const match of prose.matchAll(TICK)) note(found, seen, match[1], roots);
  return found;
}

/** One run-card line. The card also caps it at 200 characters. */
export function missingFileLine(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  const extra = files.length - Math.min(files.length, 3);
  return `Missing file: ${shown}${extra > 0 ? ` +${extra}` : ""}`;
}

function note(
  found: string[],
  seen: Set<string>,
  raw: string | undefined,
  roots: readonly string[],
): void {
  const target = (raw ?? "").split(/[?#]/)[0]?.trim() ?? "";
  if (!target || seen.has(target) || !isLocalFile(target)) return;
  seen.add(target);
  if (!roots.some((root) => fileAt(root, target))) found.push(target);
}

function isLocalFile(target: string): boolean {
  if (REMOTE.test(target) || isAbsolute(target)) return false;
  if (target.split(/[\\/]/).includes("..")) return false;
  return EXT.test(target);
}

function fileAt(root: string, target: string): boolean {
  const path = resolve(root, target);
  const child = relative(root, path);
  if (child === ".." || child.startsWith("../") || child.startsWith("..\\") || isAbsolute(child))
    return false;
  return existsSync(path);
}
