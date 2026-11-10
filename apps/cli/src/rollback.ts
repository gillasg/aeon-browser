import { randomUUID } from "node:crypto";
import { appendFile, copyFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import { has } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";

const BUILD_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,80}$/;

export interface ReleasePaths {
  root: string;
  hostConfig: string;
}

export interface RollbackResult {
  from: string;
  to: string;
  entrypoint: string;
}

interface ReleaseFile {
  current?: string;
  previous?: string;
  channel?: string;
}

export function rollbackCommand(): Command {
  return {
    name: "rollback",
    group: "Aeon",
    summary: "switch the daemon to the previous build",
    help: `Usage: aeon rollback [--json]

Points the daemon entrypoint at the previous versioned build under
%LOCALAPPDATA%\\Aeon\\builds\\<version>-<sha>\\main.js and records the swap in release.json.
Restart Aeon to run that build. Other host-config.json fields stay as they are.`,
    run: (args: Args) => runRollback(has(args, "json")),
  };
}

export function releasePaths(env: NodeJS.ProcessEnv = process.env): ReleasePaths {
  const root =
    env.AEON_HOME ?? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Aeon");
  return { root, hostConfig: env.AEON_HOST_CONFIG ?? join(root, "host-config.json") };
}

export function buildMain(root: string, id: string): string {
  assertBuildId(id);
  const file = resolve(root, "builds", id, "main.js");
  const builds = resolve(root, "builds") + sep;
  if (!samePrefix(file, builds)) throw new Error(`Build ${id} is outside the Aeon builds folder.`);
  return file;
}

/** Switches daemonEntrypoint to the previous build. Does not start or stop a running daemon. */
export async function rollbackRelease(paths: ReleasePaths): Promise<RollbackResult> {
  const release = await readRelease(join(paths.root, "release.json"));
  const to = release.previous;
  if (!to) throw new Error(NO_PREVIOUS);
  assertBuildId(to);
  const config = await readConfig(paths.hostConfig);
  const from =
    release.current ?? idFromEntrypoint(paths.root, String(config.daemonEntrypoint ?? ""));
  if (!from) throw new Error(NO_CURRENT);
  assertBuildId(from);
  if (from === to) throw new Error(ALREADY);
  const entrypoint = buildMain(paths.root, to);
  await assertDaemonFile(entrypoint, to);
  config.daemonEntrypoint = entrypoint;
  await writeJson(paths.hostConfig, config);
  await writeJson(join(paths.root, "release.json"), { ...release, current: to, previous: from });
  await appendFile(
    join(paths.root, "rollback.log"),
    `${new Date().toISOString()} from ${from} to ${to}\n`,
  );
  return { from, to, entrypoint };
}

export async function runRollback(json: boolean, paths = releasePaths()): Promise<number> {
  try {
    const result = await rollbackRelease(paths);
    process.stdout.write(
      json ? JSON.stringify({ ok: true, ...result }) + "\n" : rollbackText(result),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!json) throw error;
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    return 1;
  }
}

const NO_PREVIOUS =
  "No previous build to roll back to. Fix: record the last build as previous in release.json under the Aeon folder.";
const NO_CURRENT =
  "The current build is not recorded. Fix: set current in release.json to the running <version>-<sha>.";
const ALREADY =
  "The previous build is already the current one. Fix: install a newer build before rolling back.";

function rollbackText(result: RollbackResult): string {
  return [
    `Rolled back from ${result.from} to ${result.to}.`,
    `Daemon entrypoint: ${result.entrypoint}`,
    "Restart Aeon to run that build.",
    "",
  ].join("\n");
}

export function assertBuildId(id: string): void {
  if (!BUILD_ID.test(id) || !id.includes("-") || id.includes(".."))
    throw new Error(`Build id "${id}" must look like <version>-<sha>.`);
}

async function readRelease(path: string): Promise<ReleaseFile> {
  try {
    return releaseOf(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

function releaseOf(value: unknown): ReleaseFile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("release.json is not an object. Fix: restore current and previous build ids.");
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.current === "string" ? { current: record.current } : {}),
    ...(typeof record.previous === "string" ? { previous: record.previous } : {}),
    ...(typeof record.channel === "string" ? { channel: record.channel } : {}),
  };
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new Error("host-config.json is missing. Fix: install Aeon before rolling back.", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("host-config.json is not an object. Fix: reinstall Aeon.");
  return parsed as Record<string, unknown>;
}

async function assertDaemonFile(file: string, id: string): Promise<void> {
  const info = await stat(file).catch((error: unknown) => {
    throw missingDaemon(file, id, error);
  });
  if (!info.isFile()) throw missingDaemon(file, id);
}

function missingDaemon(file: string, id: string, cause?: unknown): Error {
  return new Error(
    `Previous build ${id} has no daemon at ${file}. Fix: restore that build's main.js.`,
    cause === undefined ? undefined : { cause },
  );
}

function idFromEntrypoint(root: string, entrypoint: string): string | undefined {
  const relativePath = relative(resolve(root, "builds"), resolve(entrypoint));
  if (relativePath.startsWith("..") || relativePath.startsWith(sep)) return undefined;
  const id = relativePath.split(/[/\\]/)[0];
  if (!id || !BUILD_ID.test(id) || !id.includes("-") || id.includes("..")) return undefined;
  return id;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await copyFile(temporary, path);
  await unlinkQuiet(temporary);
}

function unlinkQuiet(path: string): Promise<void> {
  return unlink(path).catch(() => undefined);
}

function samePrefix(file: string, prefix: string): boolean {
  if (process.platform === "win32") return file.toLowerCase().startsWith(prefix.toLowerCase());
  return file.startsWith(prefix);
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}
