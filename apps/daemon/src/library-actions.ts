import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  browserRecipeHost,
  exportRecipes,
  exportSitePack,
  importRecipes,
  installSitePack,
  readRecipe,
  readSitePack,
  runRecipe,
  siteDir,
} from "@browserkit/site-mapper";
import { runWorkflow, validateWorkflow } from "@browserkit/tools/workflow";
import { workflowActions } from "@browserkit/tools/workflow-actions";
import {
  readWorkflow,
  saveWorkflow,
  writeRun,
  workflowSlug,
} from "@browserkit/tools/workflow-store";
import {
  browserkitDataDirectory,
  isWorkflowRunning,
  markWorkflowRunning,
  noteAction,
} from "./management-library.js";

// What the Automations and Sites pages can do: run and cancel workflows, import and export
// workflows, site packs and recipes, run a site operation or recipe, and clear or switch the
// stored session for a site. Every browser action runs through the daemon's code cell runner.

export const LIBRARY_ACTIONS = [
  "run_workflow",
  "cancel_workflow",
  "import_workflow",
  "export_workflow",
  "run_site_operation",
  "run_site_recipe",
  "export_site",
  "import_site",
  "export_recipes",
  "import_recipes",
  "clear_site_session",
  "switch_site_account",
  "test_site_logged_out",
] as const;

export type LibraryAction = (typeof LIBRARY_ACTIONS)[number];

export function isLibraryAction(value: string): value is LibraryAction {
  return (LIBRARY_ACTIONS as readonly string[]).includes(value);
}

export type CodeCellRunner = (
  code: string,
  options?: { session?: string; timeoutMs?: number },
) => Promise<unknown>;

const SESSION = "management";

function required(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function preview(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 1200) ?? String(value);
  } catch {
    return String(value);
  }
}

export class LibraryActions {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly run: CodeCellRunner) {}

  async execute(action: LibraryAction, input: Record<string, unknown>): Promise<void> {
    try {
      await this.dispatch(action, input);
    } catch (error) {
      noteAction(false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private readonly handlers = new Map<
    LibraryAction,
    (input: Record<string, unknown>) => Promise<void>
  >([
    ["run_workflow", (input) => this.runWorkflow(input)],
    ["cancel_workflow", (input) => this.cancelWorkflow(input)],
    ["import_workflow", (input) => this.importWorkflow(input)],
    ["export_workflow", (input) => this.exportWorkflow(input)],
    ["run_site_operation", (input) => this.runSiteOperation(input)],
    ["run_site_recipe", (input) => this.runSiteRecipe(input)],
    ["export_site", (input) => this.exportSite(input)],
    ["import_site", (input) => this.importSite(input)],
    ["export_recipes", (input) => this.exportRecipes(input)],
    ["import_recipes", (input) => this.importRecipes(input)],
    ["clear_site_session", (input) => this.clearSession(required(input, "site"), false)],
    ["switch_site_account", (input) => this.clearSession(required(input, "site"), true)],
    ["test_site_logged_out", (input) => this.testLoggedOut(required(input, "site"))],
  ]);

  private dispatch(action: LibraryAction, input: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(action);
    if (!handler) return Promise.reject(new Error(`Unknown library action ${action}`));
    return handler(input);
  }
  private async runWorkflow(input: Record<string, unknown>): Promise<void> {
    const name = required(input, "name");
    if (isWorkflowRunning(name)) throw new Error(`${name} is already running`);
    const directory = browserkitDataDirectory();
    const definition = await readWorkflow(directory, name);
    if (!definition) throw new Error(`No workflow named ${name}`);
    const controller = new AbortController();
    this.running.set(name, controller);
    markWorkflowRunning(name, true);
    noteAction(true, `Running ${name}`);
    void runWorkflow(definition, {
      inputs: (input.inputs as Record<string, unknown>) ?? {},
      actions: workflowActions((code) => this.run(code, { session: SESSION })),
      signal: controller.signal,
    })
      .then(async (record) => {
        await writeRun(directory, record).catch(() => undefined);
        noteAction(record.status === "completed", `${record.workflow}: ${record.status}`);
      })
      .catch((error: unknown) => {
        noteAction(false, `${name}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.running.delete(name);
        markWorkflowRunning(name, false);
      });
  }

  private async cancelWorkflow(input: Record<string, unknown>): Promise<void> {
    const name = required(input, "name");
    const controller = this.running.get(name);
    if (!controller) throw new Error(`${name} is not running`);
    controller.abort();
    noteAction(true, `Cancelling ${name}`);
  }

  private async importWorkflow(input: Record<string, unknown>): Promise<void> {
    const json =
      typeof input.json === "string"
        ? input.json
        : typeof input.path === "string"
          ? await readFile(input.path, "utf8")
          : undefined;
    if (!json) throw new Error("Paste the workflow JSON or give a file path");
    const definition = validateWorkflow(JSON.parse(json));
    const saved = await saveWorkflow(browserkitDataDirectory(), definition);
    noteAction(true, `Imported ${definition.name} (${saved.path ? "saved" : "ready"})`);
  }

  private async exportWorkflow(input: Record<string, unknown>): Promise<void> {
    const name = required(input, "name");
    const directory = browserkitDataDirectory();
    const definition = await readWorkflow(directory, name);
    if (!definition) throw new Error(`No workflow named ${name}`);
    const folder = join(directory, "exports");
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${workflowSlug(name)}.json`);
    await writeFile(path, JSON.stringify({ version: 1, workflow: definition }, null, 2), "utf8");
    noteAction(true, `Exported to ${path}`);
  }

  private async runSiteOperation(input: Record<string, unknown>): Promise<void> {
    const site = required(input, "site");
    const operation = required(input, "operation");
    const params = (input.params as Record<string, unknown>) ?? {};
    const value = await this.run(
      `(async () => await siteMapper.call(${JSON.stringify(site)}, ${JSON.stringify(operation)}, ${JSON.stringify(params)}))()`,
      { session: SESSION, timeoutMs: 120_000 },
    );
    noteAction(true, `${site}/${operation}: ${preview(value)}`);
  }

  private async runSiteRecipe(input: Record<string, unknown>): Promise<void> {
    const site = required(input, "site");
    const name = required(input, "name");
    const recipe = await readRecipe(site, name);
    if (!recipe) throw new Error(`No recipe named ${name} on ${site}`);
    const host = await browserRecipeHost(site, {
      session: SESSION,
      bridge: {
        run: (code, options) => this.run(code, options),
        status: () => Promise.resolve({ browsers: 1 }),
        close: () => undefined,
      },
    });
    const result = await runRecipe({
      site,
      recipe,
      host,
      inputs: (input.params as Record<string, unknown>) ?? {},
    });
    noteAction(
      true,
      `${site}/${name}: ${result.count} record(s) via ${result.strategy ?? "recipe"}`,
    );
  }

  private async exportSite(input: Record<string, unknown>): Promise<void> {
    const site = required(input, "site");
    const path = this.exportPath(`${site}.zip`, input.path);
    await mkdir(dirname(path), { recursive: true });
    await exportSitePack({ site, out: path });
    noteAction(true, `Exported ${site} to ${path}`);
  }

  private async importSite(input: Record<string, unknown>): Promise<void> {
    const path = required(input, "path");
    const pack = await readSitePack(path);
    const installed = await installSitePack(pack);
    noteAction(true, `Imported ${installed.site} (${installed.written.length} file(s))`);
  }

  private async exportRecipes(input: Record<string, unknown>): Promise<void> {
    const site = required(input, "site");
    const path = this.exportPath(`${site}-recipes.json`, input.path);
    await mkdir(dirname(path), { recursive: true });
    const result = await exportRecipes(site, path);
    noteAction(true, `Exported ${result.count} recipe(s) to ${result.out}`);
  }

  private async importRecipes(input: Record<string, unknown>): Promise<void> {
    const path = required(input, "path");
    const site = typeof input.site === "string" ? input.site : undefined;
    const recipes = await importRecipes(path, site ? { site } : {});
    noteAction(true, `Imported ${recipes.length} recipe(s)`);
  }

  private async clearSession(site: string, signIn: boolean): Promise<void> {
    await rm(join(siteDir(site), "session.json"), { force: true });
    await this.run(
      `(async () => await browser.cookies.clear({ domain: ${JSON.stringify(site)} }))()`,
      {
        session: SESSION,
        timeoutMs: 60_000,
      },
    );
    if (!signIn) {
      noteAction(true, `Cleared the stored session for ${site}`);
      return;
    }
    const value = await this.run(
      `(async () => {
  page = await browser.openTab(${JSON.stringify(`https://${site}/`)}, { newTab: true });
  await page.waitForTimeout(1500);
  return await bu.signIn();
})()`,
      { session: SESSION, timeoutMs: 180_000 },
    );
    noteAction(true, `Switched account on ${site}: ${preview(value)}`);
  }

  /**
   * Reads the site as a signed-out visitor. With a session still stored this says so instead of
   * clearing it: testing must never quietly sign the user out.
   */
  private async testLoggedOut(site: string): Promise<void> {
    const count = (await this.run(
      `(async () => (await browser.cookies.list({ domain: ${JSON.stringify(site)} })).count)()`,
      { session: SESSION, timeoutMs: 30_000 },
    )) as number;
    if (Number(count) > 0) {
      noteAction(
        true,
        `${site} still has ${count} cookie(s), so the page is not logged out; clear the session first to test the signed-out page.`,
      );
      return;
    }
    const value = await this.run(
      `(async () => {
  const tab = await browser.openTab(${JSON.stringify(`https://${site}/`)}, { newTab: true, quiet: true });
  await tab.waitForTimeout(1200);
  return { readiness: await tab.readiness(), title: await tab.title(), url: tab.url };
})()`,
      { session: SESSION, timeoutMs: 90_000 },
    );
    noteAction(true, `${site} as a signed-out visitor: ${preview(value)}`);
  }

  private exportPath(name: string, given: unknown): string {
    if (typeof given === "string" && given.trim()) return given.trim();
    return join(browserkitDataDirectory(), "exports", name.replace(/[^\w.-]+/g, "-"));
  }
}
