import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { workspaceCall } from "./browser-workspace.js";

// A compact log of each agent run, in the chat's workspace: the tabs it opened and closed, the
// hosts it contacted, the files it wrote and the jobs it started. Every browser_code result of the
// run names the file it keeps growing ("run log: runs/<time>.json"), and the run's end writes the
// final one. A user asking "what did it do?" or a later agent picking the work up reads this.

export interface RunLogTotals {
  startedAt: number;
  tabs: { opened: number; closed: number; open: number; ids: number[] };
  hosts: Set<string>;
  files: Set<string>;
  jobs: Set<string>;
}

export interface CellTally {
  tabStats?: {
    opened?: number;
    closed?: number;
    mine?: number[];
    total?: number;
    popups?: number;
  };
  opened?: readonly { tabId?: number }[];
  steps?: readonly Record<string, unknown>[];
  files?: readonly string[];
  value?: unknown;
  output?: string;
}

const MAX_HOSTS = 60;
const runs = new Map<string, RunLogTotals>();

/** The log a run is keeping, started on the run's first cell. */
export function startRunLog(chatId: string, now = Date.now()): RunLogTotals {
  const totals: RunLogTotals = {
    startedAt: now,
    tabs: { opened: 0, closed: 0, open: 0, ids: [] },
    hosts: new Set(),
    files: new Set(),
    jobs: new Set(),
  };
  runs.set(chatId, totals);
  return totals;
}

/** Adds one cell's work to the run and returns the path its log lives at. */
export function tallyCell(chatId: string, cell: CellTally, at = Date.now()): string {
  const totals = runs.get(chatId) ?? startRunLog(chatId, at);
  addTabs(totals, cell);
  for (const host of hostsOf(cell.steps ?? [])) {
    if (totals.hosts.size >= MAX_HOSTS) break;
    totals.hosts.add(host);
  }
  for (const file of cell.files ?? []) totals.files.add(file);
  for (const job of jobIdsOf(cell)) totals.jobs.add(job);
  return runLogName(totals.startedAt);
}

/** Writes the log to the workspace; called as the run ends and after each cell that changed it. */
export async function writeRunLog(
  chatId: string,
  workspace: string | undefined,
  input: { ended?: boolean; error?: boolean } = {},
): Promise<string | undefined> {
  const totals = runs.get(chatId);
  if (!totals || !workspace) return undefined;
  const name = runLogName(totals.startedAt);
  const body = {
    startedAt: new Date(totals.startedAt).toISOString(),
    ...(input.ended ? { endedAt: new Date().toISOString() } : {}),
    ...(input.error ? { failed: true } : {}),
    tabs: totals.tabs,
    hosts: [...totals.hosts].sort(),
    files: [...totals.files],
    jobs: [...totals.jobs],
  };
  await mkdir(join(workspace, "runs"), { recursive: true });
  // checkpoint is an atomic overwrite: the log is rewritten as the run goes on.
  await workspaceCall(workspace, {
    workspace: "checkpoint",
    name,
    value: body,
  } as never);
  return name;
}

/** The run is over: write the final log and forget it. */
export async function finishRunLog(
  chatId: string,
  workspace: string | undefined,
  error?: boolean,
): Promise<string | undefined> {
  const totals = runs.get(chatId);
  if (!totals) return undefined;
  const name = await writeRunLog(chatId, workspace, {
    ended: true,
    ...(error ? { error } : {}),
  }).catch(() => undefined);
  runs.delete(chatId);
  return name;
}

export function runLogName(startedAt: number): string {
  return `runs/${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`;
}

function addTabs(totals: RunLogTotals, cell: CellTally): void {
  const stats = cell.tabStats;
  if (stats) {
    totals.tabs.opened = Math.max(totals.tabs.opened, Number(stats.opened ?? 0));
    totals.tabs.closed = Math.max(totals.tabs.closed, Number(stats.closed ?? 0));
  }
  const ids = new Set([...(totals.tabs.ids ?? []), ...(stats?.mine ?? [])]);
  for (const target of cell.opened ?? [])
    if (typeof target.tabId === "number") ids.add(target.tabId);
  totals.tabs.ids = [...ids];
  totals.tabs.open = ids.size;
}

/** Hosts a cell asked for: opens, navigations and tab URLs in its steps. */
function hostsOf(steps: readonly Record<string, unknown>[]): string[] {
  const hosts = new Set<string>();
  for (const step of steps) {
    const action = step.action as { url?: unknown } | undefined;
    const tab = (step.result as { tab?: { url?: unknown } } | undefined)?.tab;
    for (const url of [action?.url, tab?.url]) {
      const host = hostOf(url);
      if (host) hosts.add(host);
    }
  }
  return [...hosts];
}

export function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const host = new URL(url).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** Jobs a cell started: browser.job answers {jobId} in its value or its printed output. */
function jobIdsOf(cell: CellTally): string[] {
  const text = JSON.stringify([cell.value ?? null, cell.output ?? ""]).slice(0, 200_000);
  const ids: string[] = [];
  for (const match of text.matchAll(/jobId\\?"?\s*:\s*\\?"([0-9a-f-]{36})/g))
    if (match[1]) ids.push(match[1]);
  return ids;
}
