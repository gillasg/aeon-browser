import { dirname, join } from "node:path";
import {
  assertNoSealedSecrets,
  clampTimeoutMs,
  describeError,
  errorNextCall,
  leadingCode,
  readableSchemaError,
  StepEventSchema,
  type StepEvent,
} from "@graft/protocol";
import type { ModelLike } from "@browserkit/tools/site-to-api";
import { isCredentialRequest } from "@browserkit/credentials";
import { traceActions } from "./browser-trace-actions.js";
import { browserCodeGuidelines, browserCodeSummary } from "./browser-code-guidance.js";
import { compactBrowserTrace } from "./browser-recovery.js";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { browserContent, modelImageBlocks, type BrowserToolRunner } from "./browser-tool.js";
import { createSiteScriptTool } from "./site-script-tool.js";
import { createBrowserContextTool } from "./browser-context-tool.js";
import {
  isWorkspaceRequest,
  noteWorkspaceStep,
  workspaceCall,
  validateUploadFiles,
} from "./browser-workspace.js";
import { isSiteSkillRequest, siteSkillCall } from "./browser-site-skills.js";
import { SiteWrites } from "./browser-site-writes.js";
import { isSavedReadRequest, putSavedRead } from "./saved-reads.js";
import { siteMapperRequest, siteRewind } from "./site-browser.js";
import { tallyCell, writeRunLog } from "./run-log.js";
import { cellBehaviour, noteBrowserCell } from "./batch-nudge.js";
import { formatCell } from "./cell-grammar.js";
export { formatStepLine } from "./cell-grammar.js";
import { cellTimeoutMs } from "./run-budget.js";
import { cellSleepMs, cellSleepRefusal, sleepsPastDeadline } from "./cell-sleep-guard.js";
import { openUserWait, STEERED_NOTE } from "./user-waits.js";
import {
  createGraftHostHandler,
  type HostRequestContext,
  type SiteRulesProvider,
} from "./browser-host-requests.js";

const CELL_TIMEOUT_MS = 60_000;

/** The chat's connected MCP tools, exposed inside browser_code as mcp.<server>.<tool>(args). The daemon owns this. */
export interface McpBridge {
  /** Per-server counts and a capped set of one-line tool refs, with a hint to search for more. */
  list(signal?: AbortSignal): Promise<unknown>;
  /** The tools that best match a query, as one-line refs; `limit` defaults to 8. */
  search?(query: string, options?: { limit?: number }, signal?: AbortSignal): Promise<unknown>;
  /** Call one tool with JSON args; throws the tool's text on error. */
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface BrowserCodeOptions {
  /** Which sites this chat's runs must stay off, answered by the daemon. */
  siteRules?: SiteRulesProvider;
  /** A chat by default; an outside MCP session says so (no typed-user lift). */
  source?: "chat" | "external";
  /** The fast model page.observe / page.act use; without one they say so. */
  model?: () => Promise<ModelLike | undefined>;
  /** The name of the Chrome profile this chat runs in, so it signs in with that profile's vault. */
  browserName?: BrowserNameProvider;
  /** Connected MCP tools callable from a cell; without one, mcp.* says there are none. */
  mcp?: McpBridge;
}

export type BrowserNameProvider = (chatId: string) => Promise<string | undefined>;

function tooLongCell(
  envelope: () => object,
  timeoutMs: number,
  sleepMs: number,
): ReturnType<typeof offlineCell> {
  return {
    content: browserContent(
      JSON.stringify({ ...envelope(), error: cellSleepRefusal(timeoutMs, sleepMs) }),
    ),
    isError: true,
    details: undefined,
  };
}

function openCell(
  run: BrowserToolRunner | undefined,
  chatId: string,
  envelope: () => object,
  code: string,
):
  | { ok: true; timeoutMs: number; warn?: string; run: BrowserToolRunner }
  | { ok: false; result: ReturnType<typeof offlineCell> } {
  if (!run) return { ok: false, result: offlineCell(envelope) };
  const bounded = clampTimeoutMs(cellTimeoutMs(chatId, CELL_TIMEOUT_MS));
  if (bounded.timeoutMs <= 0) return { ok: false, result: spentBudget(envelope) };
  const sleepMs = cellSleepMs(code);
  if (sleepsPastDeadline(sleepMs, bounded.timeoutMs))
    return { ok: false, result: tooLongCell(envelope, bounded.timeoutMs, sleepMs) };
  return {
    ok: true,
    timeoutMs: bounded.timeoutMs,
    ...(bounded.warn ? { warn: bounded.warn } : {}),
    run,
  };
}

function spentBudget(envelope: () => object): {
  content: ReturnType<typeof browserContent>;
  isError: true;
  details: undefined;
} {
  return {
    content: browserContent(
      JSON.stringify({
        ...envelope(),
        error:
          "Not run: the time budget is spent. Answer with what you have; do not start another browser cell.",
      }),
    ),
    isError: true,
    details: undefined,
  };
}

function offlineCell(envelope: () => object): {
  content: ReturnType<typeof browserContent>;
  isError: true;
  details: undefined;
} {
  return {
    content: browserContent(
      JSON.stringify({ ...envelope(), error: describeError("BROWSER_OFFLINE") }),
    ),
    isError: true,
    details: undefined,
  };
}

export function createBrowserTools(
  chatId: string,
  run?: BrowserToolRunner,
  workspace?: string,
  skills?: string,
  options?: BrowserCodeOptions,
): ReturnType<typeof defineTool>[] {
  const browserCode = createBrowserCodeTool(chatId, run, workspace, skills, options);
  return [browserCode, createBrowserContextTool(browserCode), createSiteScriptTool(chatId, run)];
}

export function createBrowserCodeTool(
  chatId: string,
  run?: BrowserToolRunner,
  workspace?: string,
  skills?: string,
  options?: BrowserCodeOptions,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "browser_code",
    label: "Browser workflow",
    description: browserCodeSummary,
    promptSnippet: "Use browser_code for any browser task; batch steps to avoid model round trips.",
    promptGuidelines: browserCodeGuidelines,
    parameters: Type.Object(
      { code: Type.String({ minLength: 1, maxLength: 16000 }) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (toolCallId, { code }, signal, onUpdate) => {
      const opts: BrowserCodeOptions = options ?? {};
      const operationId = randomUUID();
      const startedAt = Date.now();
      let steps: Record<string, unknown>[] = [];
      let progress: ToolProgress | undefined;
      const writes = new SiteWrites((site, operation) => siteRewind(chatId, site, operation));
      const files: string[] = [];
      const envelope = () => ({
        operationId,
        toolCallId,
        steps,
        ...(progress ? { progress } : {}),
      });
      const update = () =>
        onUpdate?.({
          content: browserContent(JSON.stringify(envelope())),
          details: liveDetails(progress, steps),
        });
      const opened = openCell(run, chatId, envelope, code);
      if (!opened.ok) return opened.result;
      const timeoutMs = opened.timeoutMs;
      // A steer while the cell hands off to the user ends the cell, so the model reads it now.
      const wait = openUserWait(chatId, signal, () => steps.some(handingOff));
      const output = await opened
        .run(
          chatId,
          toolCallId,
          {
            codeCell: {
              code,
              timeoutMs,
              onCall: cellCall({
                chatId,
                source: opts.source ?? "chat",
                ...(opts.siteRules ? { siteRules: opts.siteRules } : {}),
                ...(opts.model ? { model: opts.model } : {}),
                ...(opts.browserName ? { browserName: opts.browserName } : {}),
                mcp: opts.mcp,
                // One cell's signal covers every MCP call it makes: a cancel stops the request,
                // including a reply still being read, and is never retried.
                signal: wait.signal,
                skills,
                workspace,
                writes,
                files,
                steps: () => steps,
                report: (next) => {
                  progress = next;
                  update();
                },
              }),
              onProgress: (next) => {
                steps = next.map(compactStep);
                update();
              },
            },
          },
          wait.signal,
        )
        // A steer cancels the cell, which rejects: that is the steer's answer, not a failure.
        .catch((error: unknown) => {
          if (wait.steered()) return undefined;
          throw error;
        })
        .finally(wait.close);
      if (wait.steered() || output === undefined)
        return {
          content: browserContent(JSON.stringify({ ...envelope(), error: STEERED_NOTE })),
          isError: true,
          details: undefined,
        };
      return browserCodeResult({
        chatId,
        output,
        steps,
        workspace,
        operationId,
        writes,
        files,
        startedAt,
        ...(opened.warn ? { timeoutWarn: opened.warn } : {}),
      });
    },
  });
}

interface CellOutput {
  error?: string;
  detail?: string;
  value?: unknown;
  output?: string;
  screenshots?: string[];
  steps?: Record<string, unknown>[];
  reset?: boolean;
  opened?: { tabId?: number }[];
  tabStats?: {
    opened?: number;
    closed?: number;
    mine?: number[];
    total?: number;
    popups?: number;
  };
}

/** A cell's work goes into the run's log; the result names the file it keeps growing. */
async function cellRunLog(
  chatId: string,
  workspace: string | undefined,
  files: string[],
  cell: CellOutput,
): Promise<string | undefined> {
  if (!workspace) return undefined;
  const name = tallyCell(chatId, {
    ...(cell.tabStats ? { tabStats: cell.tabStats } : {}),
    ...(cell.opened ? { opened: cell.opened } : {}),
    steps: cell.steps ?? [],
    files,
    value: cell.value,
    ...(cell.output ? { output: cell.output } : {}),
  });
  await writeRunLog(chatId, workspace).catch(() => undefined);
  return name;
}

function formatCellOutput(timeoutWarn: string | undefined, output: string | undefined): string {
  if (!timeoutWarn) return output ?? "";
  return output ? `${timeoutWarn}\n${output}` : timeoutWarn;
}

/** The tool result the model and the trace keep: steps, output, value and what was written. */
async function browserCodeResult(options: {
  chatId: string;
  output: string;
  steps: Record<string, unknown>[];
  workspace: string | undefined;
  operationId: string;
  writes: SiteWrites;
  files: string[];
  startedAt: number;
  timeoutWarn?: string;
}) {
  const { chatId, workspace, operationId, writes, files } = options;
  const cell = JSON.parse(options.output) as CellOutput;
  const steps = cell.steps
    ? [...cell.steps.map(compactStep), ...workspaceSteps(options.steps)]
    : options.steps;
  const result = {
    value: cell.value,
    output: formatCellOutput(options.timeoutWarn, cell.output),
  };
  await journalOutput(result, workspace, operationId);
  // The run log grows with every cell; this result names it for the model and the trace.
  const runLog = await cellRunLog(chatId, workspace, files, cell);
  const failed = Boolean(cell.error);
  // Three tiny cells in a row get one line asking for fuller cells; an error never carries it.
  const hint = failed ? undefined : noteBrowserCell(chatId, cellBehaviour(steps));
  const body = resultBody({ cell, steps, result, runLog, hint, failed });
  // A cell that timed out returns no steps of its own: its last progress keeps the actions (and
  // the tabs it opened) in the trace.
  const actions = traceActions(cell.steps ?? (failed ? steps : []));
  const details = resultDetails(actions, writes, cell.steps ?? []);
  const delivered = !failed && isDelivery(cell.value);
  return {
    content: await modelContent(body, options.startedAt),
    isError: failed,
    value: cell.value === undefined ? null : cell.value,
    screenshots: screenshotPaths(cell),
    details: Object.keys(details).length ? details : undefined,
    // finish_from_js handed the answer over: the run ends after this call.
    ...(delivered ? { terminate: true } : {}),
  };
}

const IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/i;

/** Absolute image paths this cell saved: the recorded list, plus a returned {saved} or {path}. */
export function screenshotPaths(cell: { screenshots?: unknown; value?: unknown }): string[] {
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string" || !IMAGE_PATH.test(value)) return;
    if (!(value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))) return;
    if (!found.includes(value)) found.push(value);
  };
  if (Array.isArray(cell.screenshots)) for (const item of cell.screenshots) push(item);
  collectSaved(cell.value, push, 0);
  return found;
}

function collectSaved(value: unknown, push: (value: unknown) => void, depth: number): void {
  if (depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSaved(item, push, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  push(record.saved);
  push(record.path);
  for (const item of Object.values(record)) collectSaved(item, push, depth + 1);
}

function isDelivery(value: unknown): boolean {
  const record = value as { delivered?: unknown; answer?: unknown } | null;
  return Boolean(
    record && typeof record === "object" && record.delivered === true && "answer" in record,
  );
}

/** Everything a cell's result carries besides the text: steps, value, output and what it left. */
function resultBody(options: {
  cell: CellOutput;
  steps: Record<string, unknown>[];
  result: { value: unknown; output: string };
  runLog: string | undefined;
  hint: string | undefined;
  failed: boolean;
}) {
  const { cell, steps, result, runLog, hint, failed } = options;
  return {
    steps,
    ...result,
    ...(cell.reset ? { reset: true } : {}),
    ...(failed ? { error: browserCodeError(cell.error, cell.detail) } : {}),
    ...(cell.tabStats ? { tabStats: cell.tabStats } : {}),
    ...(runLog ? { runLog } : {}),
    ...(hint ? { hint } : {}),
  };
}

function buildCellProof(
  writes: SiteWrites,
  rawSteps: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const vaultStep = rawSteps.find((step) => step.vault === true);
  const vaultSite = typeof vaultStep?.site === "string" ? vaultStep.site : undefined;
  const site = writes.site ?? vaultSite;
  const proof: Record<string, unknown> = {};
  if (vaultStep) proof.vault = true;
  if (writes.repairedVersion) proof.repairedVersion = writes.repairedVersion;
  if (writes.usedApi) proof.usedApi = true;
  if (writes.compiled) proof.compiled = true;
  if (writes.usedAbility) proof.usedAbility = true;
  if (site) proof.site = site;
  return proof;
}

/** What the trace keeps besides the text: the actions, the site API writes, the site that answered. */
function resultDetails(
  actions: ReturnType<typeof traceActions>,
  writes: SiteWrites,
  rawSteps: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const written = writes.list();
  const proof = buildCellProof(writes, rawSteps);
  return {
    ...(actions.length ? { actions } : {}),
    ...(written.length ? { writes: written } : {}),
    ...(writes.usedApi ? { siteMapper: true } : {}),
    ...(Object.keys(proof).length ? { proof } : {}),
  };
}

// What a running cell may ask this side for. Credentials and site rules go through browserkit's
// one host handler; Graft adds its own storage through extra. No answer there is a step or a log.
function cellCall(context: {
  chatId: string;
  source: "chat" | "external";
  siteRules?: SiteRulesProvider;
  model?: () => Promise<ModelLike | undefined>;
  browserName?: BrowserNameProvider;
  mcp: McpBridge | undefined;
  signal: AbortSignal;
  skills: string | undefined;
  workspace: string | undefined;
  writes: SiteWrites;
  /** Workspace files the cell wrote, for the run log. */
  files: string[];
  steps: () => Record<string, unknown>[];
  report: (progress: ToolProgress) => void;
}): (request: unknown) => Promise<unknown> {
  const host = createGraftHostHandler({
    source: context.source,
    ...(context.siteRules ? { siteRules: context.siteRules } : {}),
    siteMapper: (request) => siteMapperRequest(context.chatId, request),
    ...(context.model ? { model: context.model } : {}),
    extra: (request) =>
      serveCall(
        request,
        context.workspace,
        context.steps(),
        context.skills,
        context.mcp,
        context.signal,
      ),
  });
  const requestContext: HostRequestContext = {
    source: context.source,
    scope: context.chatId,
    ...(context.workspace ? { workspace: context.workspace } : {}),
  };
  return async (request) => {
    const reported = progressRequest(request);
    if (reported) {
      context.report(reported);
      return { ok: true };
    }
    // A file the cell wrote into the workspace, noted for the run log.
    if (isWorkspaceRequest(request) && isWorkspaceWrite(request)) context.files.push(request.name);
    // Only a sign-in needs to know the profile: it may have its own password manager.
    const browser =
      isCredentialRequest(request) && context.browserName
        ? await context.browserName(context.chatId).catch(() => undefined)
        : undefined;
    const answer = host(request, browser ? { ...requestContext, browser } : requestContext);
    if (answer)
      return context.writes.track(request, rememberApiRead(context.skills, request, answer));
    return Promise.reject(new Error("UNSUPPORTED: unknown browser runtime request"));
  };
}

/** checkpoint/artifact/append write; load, loadHelper and image only read. */
function isWorkspaceWrite(request: { workspace: string }): boolean {
  return !["load", "loadHelper", "image"].includes(request.workspace);
}

// The model rereads this on every later call, so it gets one line per step plus the cell's own
// output instead of the raw envelope with its repeated tab identities. Screenshots stay images.
async function modelContent(
  body: {
    steps: Record<string, unknown>[];
    output: string;
    value?: unknown;
    error?: string;
    reset?: boolean;
    runLog?: string;
    hint?: string;
    tabStats?: CellOutput["tabStats"];
  },
  startedAt: number,
): Promise<ReturnType<typeof browserContent>> {
  const fitted = await modelImageBlocks(
    browserContent(JSON.stringify({ steps: body.steps })).filter((block) => block.type === "image"),
  );
  const note = fitted
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const text = formatCell({
    steps: body.steps,
    output: body.output,
    startedAt,
    ...(body.value !== undefined ? { value: body.value } : {}),
    ...(body.error !== undefined ? { error: body.error } : {}),
    ...(body.reset !== undefined ? { reset: body.reset } : {}),
    ...(body.runLog !== undefined ? { runLog: body.runLog } : {}),
    ...(body.hint !== undefined ? { hint: body.hint } : {}),
    ...(body.tabStats ? { tabStats: body.tabStats } : {}),
  });
  return [
    { type: "text", text: note ? `${text}\n${note}` : text },
    ...fitted.filter(
      (block): block is { type: "image"; data: string; mimeType: string } => block.type === "image",
    ),
  ];
}

function liveDetails(
  progress: ToolProgress | undefined,
  steps: Record<string, unknown>[],
): { progress?: ToolProgress; steps?: ReturnType<typeof stepEvents> } | undefined {
  const events = stepEvents(steps);
  const details = {
    ...(progress ? { progress } : {}),
    ...(events.length ? { steps: events } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

function stepEvents(steps: readonly Record<string, unknown>[]): StepEvent[] {
  const events: StepEvent[] = [];
  for (const step of steps) {
    if (step.loopFolded) continue;
    const parsed = StepEventSchema.safeParse(step.event);
    if (parsed.success) events.push(parsed.data);
  }
  return events.slice(-500);
}

/** One mcp.* call from a cell: list, or call one tool with JSON args and the run's signal. */
async function serveMcp(
  request: Record<string, unknown>,
  mcp: McpBridge | undefined,
  signal: AbortSignal | undefined,
  steps: Record<string, unknown>[],
): Promise<unknown> {
  if (!mcp)
    throw new Error("No MCP tools are connected to this chat; there is nothing for mcp.* to call.");
  if (request.list === true) return mcp.list(signal);
  if (typeof request.search === "string") {
    if (!mcp.search) throw new Error("mcp.search is unavailable here; use mcp.list().");
    const limit = typeof request.limit === "number" ? request.limit : undefined;
    return mcp.search(request.search, limit === undefined ? {} : { limit }, signal);
  }
  const server = String(request.server ?? "");
  const tool = String(request.tool ?? "");
  const args =
    request.args && typeof request.args === "object" && !Array.isArray(request.args)
      ? (request.args as Record<string, unknown>)
      : {};
  // Egress canary: a cookie or token never leaves for an outside MCP server.
  assertNoSealedSecrets(args, `mcp.call ${server}.${tool}`);
  const value = await mcp.call(server, tool, args, signal);
  steps.push({ action: "mcp", result: value, server, tool });
  return value;
}

async function serveCall(
  request: unknown,
  workspace: string | undefined,
  steps: Record<string, unknown>[],
  skills: string | undefined,
  mcp?: McpBridge,
  signal?: AbortSignal,
): Promise<unknown> {
  const mcpRequest = (request as { mcp?: Record<string, unknown> } | null)?.mcp;
  if (mcpRequest) return serveMcp(mcpRequest, mcp, signal, steps);
  if (isSiteSkillRequest(request)) {
    if (!skills) throw new Error("Site skills are unavailable");
    return siteSkillCall(skills, request);
  }
  // Saved reads sit beside site skills in the data folder.
  if (isSavedReadRequest(request)) {
    if (!skills) return { saved: false };
    const saved = await putSavedRead(
      savedReadsRoot(skills),
      request.savedRead.url,
      request.savedRead.text,
    );
    return { saved };
  }
  if (isWorkspaceRequest(request)) {
    if (!workspace) throw new Error("Chat workspace is unavailable");
    const result = await workspaceCall(workspace, request);
    noteWorkspaceStep(steps, request, result);
    return result;
  }
  const upload = request as { validateUpload?: unknown };
  if (Array.isArray(upload.validateUpload))
    return validateUploadFiles(upload.validateUpload as string[], workspace ?? process.cwd());
  throw new Error("UNSUPPORTED: unknown browser runtime request");
}

export interface ToolProgress {
  done: number;
  total?: number;
  label?: string;
}

/** bu.progress(done, total, label) from a cell: how far a long job inside one call has got. */
function progressRequest(request: unknown): ToolProgress | undefined {
  const value = (request as { progress?: Record<string, unknown> } | null)?.progress;
  if (!value || typeof value !== "object") return undefined;
  const count = (item: unknown) =>
    typeof item === "number" && Number.isFinite(item) && item >= 0
      ? Math.min(Math.floor(item), 1_000_000_000)
      : undefined;
  const done = count(value.done);
  if (done === undefined) return undefined;
  const total = count(value.total);
  const label = typeof value.label === "string" ? value.label.slice(0, 200) : undefined;
  return { done, ...(total !== undefined ? { total } : {}), ...(label ? { label } : {}) };
}

function workspaceSteps(steps: Record<string, unknown>[]) {
  return steps.filter((step) => step.workspace === true);
}

function handingOff(step: Record<string, unknown>): boolean {
  const action = step.action as { op?: unknown } | undefined;
  return action?.op === "handoff" && step.disposition === "running";
}

function compactStep(step: Record<string, unknown>): Record<string, unknown> {
  return "result" in step ? { ...step, result: compactBrowserTrace(step.result) } : step;
}

function browserCodeError(message = "INTERNAL", detail?: string): string {
  const readable =
    readableSchemaError(message) ?? (detail ? readableSchemaError(detail) : undefined);
  if (readable) return withNextCall(readable);
  const text = detail ? `${message}: ${detail}` : message;
  if (/\nHint: /.test(text)) return withNextCall(text);
  const selector = selectorHint(text);
  if (selector) return withNextCall(text.split("\n")[0] + "\nHint: " + selector);
  // The runtime adds a "did you mean" from the real API when it can; otherwise point at help().
  if (!/is not a function|is not defined/.test(text)) return withNextCall(text);
  return withNextCall(text.split("\n")[0] + "\nawait help() lists what browser code can do.");
}

/** Adds the shared code's safe call when the failure names one and no host added it already. */
function withNextCall(text: string): string {
  if (/\nNext: /.test(text)) return text;
  const next = errorNextCall(leadingCode(text) ?? "");
  return next ? `${text}\nNext: ${next}` : text;
}

/** Playwright habits that are not CSS: say what to use instead. */
function selectorHint(text: string): string | undefined {
  if (!/not a valid selector|valid selector/i.test(text)) return undefined;
  if (/:has-text|:text\(|:visible|>>/.test(text))
    return "Playwright text selectors are not CSS: use page.getByText('…') or page.getByRole('button', {name: '…'}).";
  return "That is not a valid CSS selector: use page.getByRole/page.getByText, or a plain CSS selector.";
}

/** A value up to this size comes back whole, so one page.read (40k by default) needs one call. */
const RESULT_INLINE_LIMIT = 48_000;

async function journalOutput(
  cell: { output: string; value?: unknown },
  workspace: string | undefined,
  operationId: string,
) {
  if (workspace && cell.value !== undefined) {
    const encoded = JSON.stringify(cell.value);
    if (encoded && encoded.length > RESULT_INLINE_LIMIT) {
      const saved = await workspaceCall(workspace, {
        workspace: "artifact",
        name: "browser-results/" + operationId + ".json",
        value: encoded,
      });
      cell.value = {
        savedResult: saved,
        preview: encoded.slice(0, 2000),
        characters: encoded.length,
      };
    }
  }
  if (!workspace || cell.output.length <= 8000) return;
  const journal = await workspaceCall(workspace, {
    workspace: "artifact",
    name: "browser-output/" + operationId + ".txt",
    value: cell.output,
  });
  cell.output =
    cell.output.slice(0, 6000) + "\n[Full output saved: " + JSON.stringify(journal) + "]";
}

function savedReadsRoot(skills: string): string {
  return join(dirname(skills), "saved-reads");
}

/**
 * Everything a site API read returns is kept as a saved read, so pinned answers and "changed
 * since you last looked" can compare against it later. Reads only, never writes.
 */
function rememberApiRead(
  skills: string | undefined,
  request: unknown,
  sent: Promise<unknown>,
): Promise<unknown> {
  const call = request as {
    siteMapper?: string;
    site?: string;
    operation?: string;
    params?: unknown;
  };
  const site = call.site;
  const operation = call.operation;
  if (!skills || !site || !operation) return sent;
  if (call.siteMapper !== "call" && call.siteMapper !== "watch") return sent;
  return sent.then(async (value) => {
    const text = JSON.stringify(value) ?? "null";
    await putSavedRead(
      savedReadsRoot(skills),
      apiReadKey(site, operation, call.params),
      text,
    ).catch(() => false);
    return value;
  });
}

/** A stable address for one API read: the same call always compares against its own last result. */
function apiReadKey(site: string, operation: string, params: unknown): string {
  const entries =
    params && typeof params === "object"
      ? Object.entries(params as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right),
        )
      : [];
  return `graft-api://${site}/${operation}?${encodeURIComponent(JSON.stringify(entries))}`;
}
