import { dirname, join } from "node:path";
import { describeError, errorNextCall, leadingCode } from "@aeon/protocol";
import type { ModelLike } from "@browserkit/tools/site-to-api";
import { isCredentialRequest } from "@browserkit/credentials";
import { traceActions } from "./browser-trace-actions.js";
import { browserCodeGuidelines, browserCodeSummary } from "./browser-code-guidance.js";
import { compactBrowserTrace } from "./browser-recovery.js";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { browserContent, type BrowserToolRunner } from "./browser-tool.js";
import { createSiteScriptTool } from "./site-script-tool.js";
import { createBrowserContextTool } from "./browser-context-tool.js";
import { isWorkspaceRequest, workspaceCall, validateUploadFiles } from "./browser-workspace.js";
import { isSiteSkillRequest, siteSkillCall } from "./browser-site-skills.js";
import { SiteWrites } from "./browser-site-writes.js";
import { isSavedReadRequest, putSavedRead } from "./saved-reads.js";
import { siteMapperRequest } from "./site-browser.js";
import { tallyCell, writeRunLog } from "./run-log.js";
import { cellBehaviour, noteBrowserCell } from "./batch-nudge.js";
import { openUserWait, STEERED_NOTE } from "./user-waits.js";
import {
  createAeonHostHandler,
  type HostRequestContext,
  type SiteRulesProvider,
} from "./browser-host-requests.js";

const CELL_TIMEOUT_MS = 60_000;

export interface BrowserCodeOptions {
  /** Which sites this chat's runs must stay off, answered by the daemon. */
  siteRules?: SiteRulesProvider;
  /** A chat by default; an outside MCP session says so (no typed-user lift). */
  source?: "chat" | "external";
  /** The fast model page.observe / page.act use; without one they say so. */
  model?: () => Promise<ModelLike | undefined>;
  /** The name of the Chrome profile this chat runs in, so it signs in with that profile's vault. */
  browserName?: BrowserNameProvider;
}

export type BrowserNameProvider = (chatId: string) => Promise<string | undefined>;

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
      const operationId = randomUUID();
      let steps: Record<string, unknown>[] = [];
      let progress: ToolProgress | undefined;
      const writes = new SiteWrites();
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
          details: progress ? { progress } : undefined,
        });
      if (!run)
        return {
          content: browserContent(
            JSON.stringify({ ...envelope(), error: describeError("BROWSER_OFFLINE") }),
          ),
          isError: true,
          details: undefined,
        };
      // A steer while the cell hands off to the user ends the cell, so the model reads it now.
      const wait = openUserWait(chatId, signal, () => steps.some(handingOff));
      const output = await run(
        chatId,
        toolCallId,
        {
          codeCell: {
            code,
            timeoutMs: CELL_TIMEOUT_MS,
            onCall: cellCall({
              chatId,
              source: options?.source ?? "chat",
              ...(options?.siteRules ? { siteRules: options.siteRules } : {}),
              ...(options?.model ? { model: options.model } : {}),
              ...(options?.browserName ? { browserName: options.browserName } : {}),
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
      return browserCodeResult({ chatId, output, steps, workspace, operationId, writes, files });
    },
  });
}

interface CellOutput {
  error?: string;
  detail?: string;
  value?: unknown;
  output?: string;
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

/** The tool result the model and the trace keep: steps, output, value and what was written. */
async function browserCodeResult(options: {
  chatId: string;
  output: string;
  steps: Record<string, unknown>[];
  workspace: string | undefined;
  operationId: string;
  writes: SiteWrites;
  files: string[];
}) {
  const { chatId, workspace, operationId, writes, files } = options;
  let { steps } = options;
  const cell = JSON.parse(options.output) as CellOutput;
  if (cell.steps) steps = [...cell.steps.map(compactStep), ...workspaceSteps(steps)];
  const result = { value: cell.value, output: cell.output ?? "" };
  await journalOutput(result, workspace, operationId);
  // The run log grows with every cell; this result names it for the model and the trace.
  const runLog = await cellRunLog(chatId, workspace, files, cell);
  const failed = Boolean(cell.error);
  // Three tiny cells in a row get one line asking for fuller cells; an error never carries it.
  const hint = failed ? undefined : noteBrowserCell(chatId, cellBehaviour(steps));
  const body = resultBody({ cell, steps, result, runLog, hint, failed });
  const actions = traceActions(cell.steps ?? []);
  const details = resultDetails(actions, writes);
  const delivered = !failed && isDelivery(cell.value);
  return {
    content: modelContent(body),
    isError: failed,
    details: Object.keys(details).length ? details : undefined,
    // finish_from_js handed the answer over: the run ends after this call.
    ...(delivered ? { terminate: true } : {}),
  };
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

/** What the trace keeps besides the text: the actions, the site API writes, the site that answered. */
function resultDetails(
  actions: ReturnType<typeof traceActions>,
  writes: SiteWrites,
): Record<string, unknown> {
  const written = writes.list();
  return {
    ...(actions.length ? { actions } : {}),
    ...(written.length ? { writes: written } : {}),
    ...(writes.usedApi ? { siteMapper: true } : {}),
  };
}

// What a running cell may ask this side for. Credentials and site rules go through browserkit's
// one host handler; Aeon adds its own storage through extra. No answer there is a step or a log.
function cellCall(context: {
  chatId: string;
  source: "chat" | "external";
  siteRules?: SiteRulesProvider;
  model?: () => Promise<ModelLike | undefined>;
  browserName?: BrowserNameProvider;
  skills: string | undefined;
  workspace: string | undefined;
  writes: SiteWrites;
  /** Workspace files the cell wrote, for the run log. */
  files: string[];
  steps: () => Record<string, unknown>[];
  report: (progress: ToolProgress) => void;
}): (request: unknown) => Promise<unknown> {
  const host = createAeonHostHandler({
    source: context.source,
    ...(context.siteRules ? { siteRules: context.siteRules } : {}),
    siteMapper: (request) => siteMapperRequest(context.chatId, request),
    ...(context.model ? { model: context.model } : {}),
    extra: (request) => serveCall(request, context.workspace, context.steps(), context.skills),
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
function modelContent(body: {
  steps: Record<string, unknown>[];
  output: string;
  value?: unknown;
  error?: string;
  reset?: boolean;
  runLog?: string;
  hint?: string;
  tabStats?: {
    opened?: number;
    closed?: number;
    mine?: number[];
    total?: number;
    popups?: number;
  };
}): ReturnType<typeof browserContent> {
  const images = browserContent(JSON.stringify({ steps: body.steps })).slice(1);
  const parts = [stepSummary(body.steps)];
  if (body.output) parts.push("output:\n" + body.output);
  // bu.state() logs its text and returns it: the value would repeat the output word for word.
  if (body.value !== undefined && !echoed(body.output, body.value))
    parts.push("value: " + (JSON.stringify(body.value) ?? "undefined"));
  if (body.error) parts.push("error: " + body.error);
  if (body.reset) parts.push("runtime reset: top-level variables are gone");
  if (body.tabStats) parts.push(tabLine(body.tabStats));
  if (body.runLog) parts.push("run log: " + body.runLog);
  if (body.hint) parts.push("hint: " + body.hint);
  return [{ type: "text", text: parts.join("\n") }, ...images];
}

/** A string value the output already shows in full. */
function echoed(output: string, value: unknown): boolean {
  return typeof value === "string" && value.length > 40 && output.includes(value);
}

function tabLine(stats: NonNullable<CellOutput["tabStats"]>): string {
  const ids = stats.mine ?? [];
  return (
    `tabs: opened ${stats.opened ?? 0}, closed ${stats.closed ?? 0}, mine ${ids.length}` +
    `${ids.length ? ` (${ids.join(", ")})` : ""}, total ${stats.total ?? 0}` +
    `${stats.popups ? `; popups: ${stats.popups} parked` : ""}`
  );
}

function stepSummary(steps: Record<string, unknown>[]): string {
  const lines = steps.filter((step) => step.action !== undefined).map(stepLine);
  if (!lines.length) return "steps: none";
  const shown = lines.length > 40 ? [...lines.slice(0, 10), "...", ...lines.slice(-29)] : lines;
  return "steps:\n" + shown.join("\n");
}

function stepLine(step: Record<string, unknown>): string {
  if (typeof step.action !== "object" || step.action === null) return "- " + String(step.action);
  const action = step.action as Record<string, unknown>;
  const detail = actionDetail(action);
  const result = step.result as
    { kind?: unknown; tab?: { target?: { tabId?: unknown } } } | undefined;
  const opened = result?.kind === "tab" ? " -> tab " + String(result.tab?.target?.tabId) : "";
  const failed =
    step.disposition === "failed"
      ? " FAILED " + String(step.code ?? "") + (step.detail ? ": " + String(step.detail) : "")
      : "";
  return (
    "- " + String(action.op) + (detail ? " " + detail : "") + opened + failed + recoveryLine(step)
  );
}

/** The executable next call on a step whose effect was not confirmed. */
function recoveryLine(step: Record<string, unknown>): string {
  const result = step.result;
  if (!result || typeof result !== "object") return "";
  const next = (result as { next?: unknown }).next;
  if (typeof next !== "string" || !next) return "";
  if (String(step.code ?? "").includes("\nNext:")) return "";
  return "\n  Next: " + next;
}

function actionDetail(action: Record<string, unknown>): string {
  const target = action.target as { tabId?: unknown } | undefined;
  const element = action.element as Record<string, unknown> | undefined;
  const id = element && (element.backendNodeId ?? element.value ?? element.ref ?? element.role);
  return [
    target?.tabId !== undefined ? "tab " + String(target.tabId) : "",
    typeof action.url === "string" ? action.url : "",
    id === undefined ? "" : String(id),
    typeof action.method === "string" ? action.method : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function serveCall(
  request: unknown,
  workspace: string | undefined,
  steps: Record<string, unknown>[],
  skills: string | undefined,
): Promise<unknown> {
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
    steps.push({ action: request.workspace, result, workspace: true });
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
  return `aeon-api://${site}/${operation}?${encodeURIComponent(JSON.stringify(entries))}`;
}
