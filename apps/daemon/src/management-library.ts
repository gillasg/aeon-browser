import { homedir } from "node:os";
import { join } from "node:path";
import { listSites, readHealth, readSession } from "@browserkit/site-mapper";
import { listRuns, listWorkflows } from "@browserkit/tools/workflow-store";

// What the Automations and Sites pages show. Read-only: workflows and runs come from browserkit's
// shared data folder, sites and sessions from the site registry. Running or clearing happens from
// the CLI until the pages get their own actions.

/** browserkit's data folder, where workflows and runs live (same rules as the bridge). */
export function browserkitDataDirectory(): string {
  const home = process.env.BROWSERKIT_HOME ?? process.env.BROWSER_USE_EXTENSION_HOME;
  if (home) return home;
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, "browserkit");
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "browserkit");
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "browserkit");
}

export interface WorkflowCard {
  name: string;
  slug: string;
  steps: number;
  description?: string;
  updatedAt: string;
  lastRun: {
    state: "ok" | "failed" | "running" | "cancelled";
    at: string;
    error: string | null;
  } | null;
}

export async function workflowCards(): Promise<WorkflowCard[]> {
  const directory = browserkitDataDirectory();
  const workflows = await listWorkflows(directory).catch(() => []);
  const cards: WorkflowCard[] = [];
  for (const workflow of workflows.slice(0, 100)) {
    const runs = await listRuns(directory, workflow.name).catch(() => []);
    const last = runs[0];
    cards.push({
      name: workflow.name,
      slug: workflow.slug,
      steps: workflow.steps,
      ...(workflow.description ? { description: workflow.description } : {}),
      updatedAt: new Date(workflow.updatedAt).toISOString(),
      lastRun: last
        ? {
            state: last.status === "completed" ? "ok" : "failed",
            at: last.finishedAt,
            error: last.error ?? null,
          }
        : null,
    });
  }
  return cards;
}

export interface SiteCard {
  site: string;
  operations: number;
  updatedAt: string;
  health: string;
  session: boolean;
}

const HEALTH_ORDER = ["broken", "signed-out", "drift", "challenged", "skipped", "ok"];

export async function siteCards(): Promise<SiteCard[]> {
  const sites = await listSites().catch(() => []);
  const cards: SiteCard[] = [];
  for (const site of sites.slice(0, 200)) {
    const [health, session] = await Promise.all([
      readHealth(site.site).catch(() => undefined),
      readSession(site.site).catch(() => undefined),
    ]);
    const statuses = (health?.results ?? []).map((result) => result.status);
    const healthState =
      statuses.length === 0
        ? "unknown"
        : (HEALTH_ORDER.find((state) => statuses.includes(state as never)) ?? "ok");
    cards.push({
      site: site.site,
      operations: site.operations,
      updatedAt: site.updated,
      health: healthState,
      session: session !== undefined,
    });
  }
  return cards;
}
