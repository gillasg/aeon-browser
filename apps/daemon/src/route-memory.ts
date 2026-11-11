// Per-site memory the card needs: how long the task took last time, and offers the user declined.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName, writeAtomic } from "@browserkit/site-mapper";

export async function previousDuration(site: string, task: string): Promise<number | undefined> {
  const file = await readJson(site, "durations.json");
  const value = file[task];
  return typeof value === "number" ? value : undefined;
}

export async function rememberDuration(site: string, task: string, ms: number): Promise<void> {
  const file = await readJson(site, "durations.json");
  file[task] = ms;
  await writeJson(site, "durations.json", file);
}

export async function declinesFor(site: string): Promise<string[]> {
  const file = await readJson(site, "declined.json");
  const ids = file.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export async function rememberDecline(site: string, id: string): Promise<void> {
  const ids = new Set(await declinesFor(site));
  ids.add(id);
  await writeJson(site, "declined.json", { ids: [...ids].slice(-80) });
}

async function readJson(site: string, name: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(pathOf(site, name), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeJson(site: string, name: string, value: unknown): Promise<void> {
  const folder = siteDir(siteName(site));
  await mkdir(folder, { recursive: true });
  await writeAtomic(pathOf(site, name), JSON.stringify(value) + "\n");
}

function pathOf(site: string, name: string): string {
  return join(siteDir(siteName(site)), name);
}
