import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  browserRecipeHost,
  rebuild,
  RecordingSession,
  saveRecording,
  exportRecipes,
  exportSitePack,
  importRecipes,
  installSitePack,
  readRecipe,
  readSitePack,
  runRecipe,
  siteDir,
} from "@browserkit/site-mapper";
import { PROVIDER_IDS, PROVIDERS, isProviderId } from "@browserkit/tools/providers";
import { askProviderWith } from "@browserkit/tools/providers-run";
import { runWorkflow, validateWorkflow, type WorkflowDefinition } from "@browserkit/tools/workflow";
import { workflowActions } from "@browserkit/tools/workflow-actions";
import {
  readWorkflow,
  saveWorkflow,
  writeRun,
  workflowSlug,
} from "@browserkit/tools/workflow-store";
import {
  browserkitDataDirectory,
  clearWorkflowProgress,
  isSiteRecording,
  isWorkflowRunning,
  markSiteRecording,
  markWorkflowProgress,
  markWorkflowRunning,
  noteAction,
  noteProviderTest,
  providerCards,
  setProviderCards,
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
  "record_workflow_from_run",
  "start_site_recording",
  "stop_site_recording",
  "check_providers",
  "test_provider",
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

  private readonly recordings = new Map<string, RecordingSession>();

  constructor(
    private readonly run: CodeCellRunner,
    private readonly dataDirectory?: string,
  ) {}

  async execute(action: LibraryAction, input: Record<string, unknown>, chatId = ""): Promise<void> {
    try {
      if (action === "record_workflow_from_run") {
        await this.recordWorkflowFromRun(input, chatId);
        return;
      }
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
    ["start_site_recording", (input) => this.startRecording(input)],
    ["stop_site_recording", (input) => this.stopRecording(input)],
    ["check_providers", () => this.checkProviders()],
    ["test_provider", (input) => this.testProvider(input)],
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
    const total = definition.steps.length;
    void runWorkflow(definition, {
      inputs: (input.inputs as Record<string, unknown>) ?? {},
      actions: workflowActions((code) => this.run(code, { session: SESSION })),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "step.started")
          markWorkflowProgress(name, {
            step: event.step + 1,
            total,
            id: event.id,
            action: event.action,
          });
        if (event.type === "step.finished")
          markWorkflowProgress(name, {
            step: Math.max(1, event.step + 1),
            total,
            id: event.id,
            action: "done",
          });
      },
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
        clearWorkflowProgress(name);
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
  page = await browser.openTab(${JSON.stringify(`https://${site}/`)}, { newTab: true, space: 'window' });
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
  const tab = await browser.openTab(${JSON.stringify(`https://${site}/`)}, { newTab: true, quiet: true, space: 'window' });
  await tab.waitForTimeout(1200);
  return { readiness: await tab.readiness(), title: await tab.title(), url: tab.url };
})()`,
      { session: SESSION, timeoutMs: 90_000 },
    );
    noteAction(true, `${site} as a signed-out visitor: ${preview(value)}`);
  }

  /** Turn the browser actions of a chat's latest run log into a workflow. */
  private async recordWorkflowFromRun(
    input: Record<string, unknown>,
    chatId: string,
  ): Promise<void> {
    const name = required(input, "name");
    if (!this.dataDirectory) throw new Error("The run log folder is unavailable here");
    if (!chatId) throw new Error("Select a chat with a browser run first");
    const folder = join(this.dataDirectory, "workspaces", chatId, "runs");
    const files = (await readdir(folder).catch(() => [] as string[]))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .reverse();
    if (!files[0]) throw new Error("That chat has no run log yet; run it once with the browser");
    const log = JSON.parse(await readFile(join(folder, files[0]), "utf8")) as {
      actions?: unknown;
    };
    const actions = Array.isArray(log.actions) ? log.actions : [];
    const definition = workflowFromActions(name, actions as Record<string, unknown>[]);
    await saveWorkflow(browserkitDataDirectory(), definition);
    noteAction(
      true,
      `Recorded ${definition.steps.length} step(s) from the last run into ${definition.name}`,
    );
  }

  /** Start recording a site flow in a foreground tab; the user interacts, then stops it. */
  private async startRecording(input: Record<string, unknown>): Promise<void> {
    const site = required(input, "site");
    if (isSiteRecording(site) || this.recordings.has(site))
      throw new Error(`A recording for ${site} is already running`);
    const url = typeof input.url === "string" && input.url ? input.url : `https://${site}/`;
    const session = await RecordingSession.start({
      url,
      foreground: true,
      session: "site-recording",
      bridge: () =>
        Promise.resolve({
          run: (code: string, options?: { session?: string; timeoutMs?: number }) =>
            this.run(code, options),
          status: () => Promise.resolve({ browsers: 1 }),
          close: () => undefined,
        }),
    });
    this.recordings.set(site, session);
    markSiteRecording(site, true);
    noteAction(true, `Recording ${site}; use the tab, then press Stop recording`);
  }

  /** Stop the recording, save the flow and rebuild the site's API from it. */
  private async stopRecording(input: Record<string, unknown>): Promise<void> {
    const site = required(input, "site");
    const session = this.recordings.get(site);
    if (!session) throw new Error(`No recording is running for ${site}`);
    const recording = await session.stop({ close: false });
    this.recordings.delete(site);
    markSiteRecording(site, false);
    const name =
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : `flow-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const file = await saveRecording(site, recording, { name });
    const rebuilt = await rebuild(site).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    noteAction(
      "error" in rebuilt ? false : true,
      `Saved ${file}` +
        ("error" in rebuilt ? `; rebuild failed: ${rebuilt.error}` : `; ${site} rebuilt`),
    );
  }

  /** Browser accounts: which providers have a session in Chrome, and an optional test query. */
  private async checkProviders(): Promise<void> {
    const cards = [];
    for (const id of PROVIDER_IDS) {
      const definition = PROVIDERS[id];
      const cookies =
        Number(
          await this.run(
            `(async () => {
  const domains = ${JSON.stringify(definition.cookieDomains)};
  let total = 0;
  for (const domain of domains) {
    const listed = await browser.cookies.list({ domain }).catch(() => ({ count: 0 }));
    total += Number(listed.count || 0);
  }
  return total;
})()`,
            { session: SESSION, timeoutMs: 30_000 },
          ),
        ) || 0;
      let account: string | null = null;
      if (id === "chatgpt" && cookies > 0) {
        const email = await this.run(
          `(async () => {
  const reply = await browser.fetch("https://chatgpt.com/api/auth/session").catch(() => null);
  return reply && reply.json && reply.json.user ? reply.json.user.email ?? null : null;
})()`,
          { session: SESSION, timeoutMs: 30_000 },
        ).catch(() => null);
        account = typeof email === "string" ? email : null;
      }
      cards.push({
        id,
        name: definition.name,
        host: definition.host,
        signedIn: cookies > 0,
        cookies,
        account,
        transport: "direct + page",
        lastTest: providerCards().find((card) => card.id === id)?.lastTest ?? null,
      });
    }
    setProviderCards(cards);
    noteAction(true, `Checked ${cards.length} browser accounts`);
  }

  private async testProvider(input: Record<string, unknown>): Promise<void> {
    const provider = required(input, "provider");
    if (!isProviderId(provider)) throw new Error(`Unknown provider ${provider}`);
    const prompt =
      typeof input.prompt === "string" && input.prompt.trim()
        ? input.prompt.trim()
        : "Reply with the single word: ok";
    const answer = await askProviderWith(
      (code, options) => this.run(code, { session: SESSION, ...(options ?? {}) }),
      provider,
      prompt,
      { timeoutMs: 60_000 },
    );
    noteProviderTest(
      provider,
      answer.ok ? answer.text : `${answer.reason ?? "failed"}: ${answer.detail ?? ""}`,
    );
    noteAction(
      answer.ok,
      `${provider}: ${answer.ok ? answer.text.slice(0, 200) : (answer.reason ?? "failed")}`,
    );
  }

  private exportPath(name: string, given: unknown): string {
    if (typeof given === "string" && given.trim()) return given.trim();
    return join(browserkitDataDirectory(), "exports", name.replace(/[^\w.-]+/g, "-"));
  }
}

/** The workflow a run's browser actions describe: opens, clicks, fills and key presses. */
export function workflowFromActions(
  name: string,
  actions: Record<string, unknown>[],
): WorkflowDefinition {
  const steps: { id: string; do: string; with: Record<string, unknown> }[] = [];
  for (const action of actions) {
    const step = stepFromAction(action, steps.length + 1);
    if (step) steps.push(step);
  }
  if (!steps.length) throw new Error("That run has no browser actions to record");
  return validateWorkflow({ name, steps });
}

/** One action as a workflow step, or nothing when it is not a page action. */
function stepFromAction(
  action: Record<string, unknown>,
  index: number,
): { id: string; do: string; with: Record<string, unknown> } | undefined {
  const op = String(action.op ?? "");
  const id = `step-${index}`;
  if ((op === "openTab" || op === "navigate") && typeof action.url === "string")
    return { id, do: "goto", with: { url: action.url } };
  if (op === "click" || op === "fill") {
    const target = targetOf(action.element as Record<string, unknown> | undefined);
    if (!target) return undefined;
    return {
      id,
      do: op,
      with: { ...target, ...(op === "fill" ? { value: String(action.value ?? "") } : {}) },
    };
  }
  if (op === "press" && typeof action.key === "string")
    return { id, do: "press", with: { key: action.key } };
  return undefined;
}

const QUERY_TARGETS: Record<string, (value: string) => Record<string, unknown>> = {
  css: (value) => ({ css: value }),
  text: (value) => ({ text: value }),
  label: (value) => ({ label: value }),
  placeholder: (value) => ({ placeholder: value }),
  role: (value) => ({ role: value }),
};

function targetOf(
  element: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!element) return undefined;
  const direct = directTarget(element);
  if (direct) return direct;
  if (
    element.kind !== "query" ||
    typeof element.by !== "string" ||
    typeof element.value !== "string"
  )
    return undefined;
  return QUERY_TARGETS[element.by]?.(element.value);
}

/** A css/selector or locator target, before the query form. */
function directTarget(element: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof element.css === "string") return { css: element.css };
  if (typeof element.selector === "string") return { css: element.selector };
  if (element.kind === "locator" && typeof element.role === "string")
    return {
      role: element.role,
      ...(typeof element.name === "string" ? { name: element.name } : {}),
    };
  return undefined;
}
