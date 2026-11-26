// The compiled site ops file, `api.json`: every callable thing on a site in one list. HTTP ops
// come from the site's API model and API-backed abilities; script ops come from built-in
// abilities, script abilities and helper snippets. A leaf module: it only reads and writes.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName, writeAtomic } from "./registry.js";

export const OPS_FILE = "api.json";

export type SiteOpKind = "http" | "script";
export type SiteOpSource = "api" | "ability" | "builtin" | "helper";

/** The shape and read-back guards an ability op keeps; the runner enforces them. */
export interface SiteOpGuards {
  /** JSON Schema the answer must keep (shape drift). */
  shape?: Record<string, unknown>;
  /** JSON pointer to the list the answer returns. */
  list?: string;
  /** Writes: the read that confirms the change. */
  readBack?: string;
}

export interface SiteOp {
  id: string;
  kind: SiteOpKind;
  source: SiteOpSource;
  summary?: string;
  /** HTTP ops. */
  method?: string;
  path?: string;
  /** Ability ops: the ability that runs, its version, and the ways it falls back through. */
  ability?: string;
  version?: number;
  via?: string[];
  /** The op declares an HTTP way and a script or page way: HTTP first, then the rest. */
  fallback?: boolean;
  effect?: "read" | "write" | "irreversible";
  guards?: SiteOpGuards;
  /** MCP `outputSchema` (object root) for the op's answer. Optional; older files lack it. */
  outputSchema?: Record<string, unknown>;
  /** Script ops written as helpers: the code, and the hosts it is for. */
  code?: string;
  domains?: string[];
  description?: string;
  examples?: string;
  enabled?: boolean;
  updatedAt?: number;
}

export interface SiteOpsFile {
  version: 1;
  site: string;
  compiledAt: string;
  ops: SiteOp[];
}

export function opsPath(site: string): string {
  return join(siteDir(siteName(site)), OPS_FILE);
}

export async function readOpsFile(site: string): Promise<SiteOpsFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(opsPath(site), "utf8")) as SiteOpsFile;
    if (!parsed || !Array.isArray(parsed.ops)) return undefined;
    return { ...parsed, ops: parsed.ops.filter((op) => op && typeof op.id === "string") };
  } catch {
    return undefined;
  }
}

export async function writeOpsFile(site: string, ops: readonly SiteOp[]): Promise<SiteOpsFile> {
  const host = siteName(site);
  const file: SiteOpsFile = {
    version: 1,
    site: host,
    compiledAt: new Date().toISOString(),
    ops: [...ops],
  };
  await mkdir(siteDir(host), { recursive: true });
  await writeAtomic(opsPath(host), JSON.stringify(file, null, 2) + "\n");
  return file;
}

/** Helper ops stored in `api.json`; compiled ops are rebuilt, helpers are kept. */
export async function readHelperOps(site: string): Promise<SiteOp[]> {
  return ((await readOpsFile(site))?.ops ?? []).filter((op) => op.source === "helper");
}
