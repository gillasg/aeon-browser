import { homedir } from "node:os";
import { join } from "node:path";
import {
  coverage,
  listRecipes,
  listSites,
  loadModel,
  readHealth,
  readSession,
} from "@browserkit/site-mapper";
import { listRuns, listWorkflows, readWorkflow } from "@browserkit/tools/workflow-store";

// What the Automations and Sites pages show: workflows with their inputs and last run, mapped
// sites with recipes, health and the stored session. Read-only reads; actions live next door.

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

export interface WorkflowInputCard {
  name: string;
  required: boolean;
  description?: string;
  default?: unknown;
}

export interface WorkflowCard {
  name: string;
  slug: string;
  steps: number;
  description?: string;
  updatedAt: string;
  inputs: WorkflowInputCard[];
  running: boolean;
  progress?: { step: number; total: number; id: string; action: string };
  lastRun: {
    state: "ok" | "failed" | "running" | "cancelled";
    at: string;
    error: string | null;
  } | null;
}

const running = new Set<string>();
let lastAction: { ok: boolean; at: string; message: string } | null = null;

export function markWorkflowRunning(name: string, value: boolean): void {
  if (value) running.add(name);
  else running.delete(name);
}

export function isWorkflowRunning(name: string): boolean {
  return running.has(name);
}

const progress = new Map<string, { step: number; total: number; id: string; action: string }>();

export function markWorkflowProgress(
  name: string,
  value: { step: number; total: number; id: string; action: string },
): void {
  progress.set(name, value);
}

export function clearWorkflowProgress(name: string): void {
  progress.delete(name);
}

const recordingSites = new Set<string>();

export function markSiteRecording(site: string, value: boolean): void {
  if (value) recordingSites.add(site);
  else recordingSites.delete(site);
}

export function isSiteRecording(site: string): boolean {
  return recordingSites.has(site);
}

/** The last library action's outcome, carried in the snapshot so a page can show it. */
export function noteAction(ok: boolean, message: string): void {
  lastAction = { ok, at: new Date().toISOString(), message: message.slice(0, 2000) };
}

export function lastActionNote(): { ok: boolean; at: string; message: string } | null {
  return lastAction;
}

export async function workflowCards(): Promise<WorkflowCard[]> {
  const directory = browserkitDataDirectory();
  const workflows = await listWorkflows(directory).catch(() => []);
  const cards: WorkflowCard[] = [];
  for (const workflow of workflows.slice(0, 100)) {
    const [runs, definition] = await Promise.all([
      listRuns(directory, workflow.name).catch(() => []),
      readWorkflow(directory, workflow.name).catch(() => undefined),
    ]);
    const last = runs[0];
    const inputs = Object.entries(definition?.inputs ?? {}).map(([name, input]) => ({
      name,
      required: input.required === true,
      ...(input.description ? { description: input.description } : {}),
      ...(input.default === undefined ? {} : { default: input.default }),
    }));
    const current = progress.get(workflow.name);
    cards.push({
      name: workflow.name,
      slug: workflow.slug,
      steps: workflow.steps,
      ...(workflow.description ? { description: workflow.description } : {}),
      updatedAt: new Date(workflow.updatedAt).toISOString(),
      inputs,
      running: running.has(workflow.name),
      ...(current ? { progress: current } : {}),
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

export interface RecipeCard {
  name: string;
  kind: "items" | "single";
  fields: number;
  updatedAt: string;
}

export interface SiteCard {
  site: string;
  operations: number;
  updatedAt: string;
  health: string;
  session: boolean;
  sessionAccount: string | null;
  sessionSavedAt: string | null;
  recipes: RecipeCard[];
  recording: boolean;
  suggestions: string[];
}

const HEALTH_ORDER = ["broken", "signed-out", "drift", "challenged", "skipped", "ok"];

export async function siteCards(): Promise<SiteCard[]> {
  const sites = await listSites().catch(() => []);
  const cards: SiteCard[] = [];
  for (const site of sites.slice(0, 200)) {
    const [health, session, recipes, model] = await Promise.all([
      readHealth(site.site).catch(() => undefined),
      readSession(site.site).catch(() => undefined),
      listRecipes(site.site).catch(() => []),
      loadModel(site.site).catch(() => undefined),
    ]);
    const statuses = (health?.results ?? []).map((result) => result.status);
    const healthState =
      statuses.length === 0
        ? "unknown"
        : (HEALTH_ORDER.find((state) => statuses.includes(state as never)) ?? "ok");
    const stored = session as
      { account?: unknown; savedAt?: unknown; updatedAt?: unknown } | undefined;
    cards.push({
      site: site.site,
      operations: site.operations,
      updatedAt: site.updated,
      health: healthState,
      session: session !== undefined,
      sessionAccount: typeof stored?.account === "string" ? stored.account : null,
      sessionSavedAt:
        typeof stored?.savedAt === "string"
          ? stored.savedAt
          : typeof stored?.updatedAt === "string"
            ? stored.updatedAt
            : null,
      recipes: recipes.map((recipe) => ({
        name: recipe.name,
        kind: recipe.kind,
        fields: recipe.fields.length,
        updatedAt: recipe.updatedAt,
      })),
      recording: isSiteRecording(site.site),
      suggestions: model
        ? coverage(model, [])
            .slice(0, 5)
            .map((item) => item.message)
        : [],
    });
  }
  return cards;
}

export interface ProviderCard {
  id: string;
  name: string;
  host: string;
  signedIn: boolean;
  cookies: number;
  account: string | null;
  transport: string;
  lastTest: string | null;
}

let providerState: ProviderCard[] = [];

export function setProviderCards(cards: ProviderCard[]): void {
  providerState = cards;
}

export function providerCards(): ProviderCard[] {
  return providerState;
}

export function noteProviderTest(id: string, text: string): void {
  providerState = providerState.map((card) =>
    card.id === id ? { ...card, lastTest: text.slice(0, 500) } : card,
  );
}
