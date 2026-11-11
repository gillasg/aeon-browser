import { stepTrace, takeActionTiming } from "./native-browser-action-timing.js";
import { recordStep } from "./evidence/step-record.js";
import type { StepEvent } from "@browserkit/protocol";
import { runEffect, type KernelChecks } from "./kernel.js";
import { cellEffects } from "./code-runtime-effects.js";
import { describeKernelError } from "./kernel-errors.js";
import {
  BrowserCodeCancelSchema,
  BrowserCodeReplySchema,
  BrowserCodeRunSchema,
  BrowserCodeStageSchema,
  BrowserStepSchema,
  type BrowserCodeRun,
  type BrowserCodeStage,
  type BrowserStep,
  type BrowserTargetKey,
} from "@browserkit/protocol";
import {
  browserErrorContext,
  browserErrorDetail,
  errorCode,
  targetIdentity,
} from "./native-browser-common.js";
import { OFFSCREEN, offscreenClosed, toOffscreen } from "./code-offscreen-host.js";
import { stepFailure } from "./code-step-errors.js";
import { refusedEffect } from "./native-browser-effect.js";
import { jobs } from "./code-runtime-jobs.js";
import { finishJob, cancelJobs } from "./code-runtime-job-control.js";
import { executeLocalBrowserStep } from "./native-browser-executor.js";
import { agentTypedIn, noteAgentText } from "./native-browser-password-lock.js";
import { scrubError, scrubSecrets } from "./native-browser-secrets.js";
import { browserSessionOwner } from "./native-browser-session.js";
import { currentInventoryTabs } from "./native-inventory-client.js";
import { notePreviewActivity } from "./native-browser-preview.js";
import { matchChromeSaving } from "./native-browser-chrome-saving.js";
import {
  captureTypedPassword,
  failedSave,
  finishVaultCapture,
  MANAGER_DID_NOT_SAVE,
  retryVaultSave,
  SAVE_IN_CHROME,
  SAVED_AFTER_UNLOCK,
  unlockToSave,
  UNSAVED_LOGIN_NOTE,
  UNSAVED_LOGIN_SAVED,
  VAULT_SAVED,
  vaultCandidate,
} from "./native-browser-vault.js";
import {
  NO_RULES,
  assertAllowed,
  combinedRules,
  guardTab,
  releaseTabs,
  type SiteRules,
} from "./native-browser-site-rules.js";
import {
  dismissHandoffPage,
  handOffToUser,
  publishHandoffWaiting,
  takeTypedAnswer,
} from "./native-browser-handoff.js";
import { presentBrowserTask, presentsBrowserTask } from "./native-browser-layout.js";
import { engineConfig } from "./engine-config.js";
import { agentTabSummary, unusedAgentTabs } from "./native-browser-tab-cleanup.js";
import { setOwnerTitle } from "./native-browser-owner.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

const MAX_STEPS = 1000;
const MAX_TRACE = 256;

export interface Cell {
  run: BrowserCodeRun;
  socket: WebSocket;
  identity: BrowserIdentity;
  operationId: string;
  allowed: Map<string, BrowserTargetKey>;
  opened: Map<string, BrowserTargetKey>;
  steps: Record<string, unknown>[];
  /** Finished steps, shared by the model line, the timeline and the ledger. */
  events: StepEvent[];
  count: number;
  calls: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  sequence: number;
  progressTimer: ReturnType<typeof setTimeout> | undefined;
  waitingForUser: boolean;
  done: boolean;
  /** Sites the machine says are off limits for this cell, asked once. */
  siteRules?: Promise<SiteRules>;
  /** Tabs holding a block rule for this cell, lifted when it finishes. */
  guarded: Set<number>;
  /** Popup count when the cell started, so its tab line says what this cell parked. */
  popupsAtStart: number;
  /** When the cell began; its result carries the total ms. */
  startedAt?: number;
}
const cells = new Map<string, Cell>();

/** Handles browser.code.* frames from Core. Returns false for anything else. */
export function handleBrowserCodeMessage(
  identity: BrowserIdentity,
  socket: WebSocket,
  candidate: unknown,
): boolean {
  const run = BrowserCodeRunSchema.safeParse(candidate);
  if (run.success) {
    void startCell(identity, socket, run.data);
    return true;
  }
  const reply = BrowserCodeReplySchema.safeParse(candidate);
  if (reply.success) {
    const owner = cells.get(reply.data.cellId) ?? jobs.get(reply.data.cellId);
    const waiter = owner?.calls.get(reply.data.callId);
    owner?.calls.delete(reply.data.callId);
    if (reply.data.error !== undefined) waiter?.reject(new Error(reply.data.error));
    else waiter?.resolve(reply.data.value);
    return true;
  }
  const cancel = BrowserCodeCancelSchema.safeParse(candidate);
  if (cancel.success) {
    const cell = cells.get(cancel.data.cellId);
    const reset = cancel.data.reset === true;
    if (cell && reset) void resetRealm(cell.run.chatId);
    if (cell)
      finish(cell, {
        output: "",
        error: reset
          ? "RUN_RESET: browser workflow cancelled; runtime reset"
          : "RUN_RESET: browser workflow cancelled",
        reset,
      });
    return true;
  }
  return false;
}

/** A dropped link reconnected: running cells and jobs answer on the new socket. */
export function rebindBrowserCodeSocket(socket: WebSocket): void {
  for (const cell of cells.values()) cell.socket = socket;
  for (const job of jobs.values()) if (job.status === "running") job.socket = socket;
}

const RESET_ANSWER_MS = 5000;

/** Drops a chat's REPL realm (session closed or runtime reset). */
export async function resetRealm(chatId: string): Promise<void> {
  cancelJobs(chatId);
  if (!(await chrome.offscreen.hasDocument())) return;
  const reset = chrome.runtime
    .sendMessage({ target: "aeon-code-offscreen", kind: "reset", chatId })
    .then(
      () => true,
      // No document listening: nothing is hung, so nothing to close.
      () => true,
    );
  // A synchronous infinite loop blocks the realm's thread; closing the document is the only kill.
  // Closing it also ends every other chat's running cell, so only a thread that stays blocked for
  // seconds (never one merely busy for a moment while other chats work) is killed this way.
  const answered = await Promise.race([
    reset,
    new Promise((done) => setTimeout(done, RESET_ANSWER_MS, false)),
  ]);
  if (!answered) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
    offscreenClosed();
  }
}

async function startCell(identity: BrowserIdentity, socket: WebSocket, run: BrowserCodeRun) {
  setOwnerTitle(run.chatId, run.ownerTitle);
  const allowed = new Map(run.targets.map((target) => [targetIdentity(target), target]));
  const cell: Cell = {
    run,
    socket,
    identity,
    operationId: crypto.randomUUID(),
    allowed,
    opened: new Map(),
    guarded: new Set(),
    steps: [],
    events: [],
    count: 0,
    calls: new Map(),
    sequence: 0,
    progressTimer: undefined,
    waitingForUser: false,
    done: false,
    popupsAtStart: agentTabSummary(run.chatId).popups,
  };
  cell.startedAt = Date.now();
  cells.set(run.cellId, cell);
  // The caller's proof the connection carried the run; without it, it fails fast and reconnects.
  sendStage(cell, "received");
  try {
    const result = (await toOffscreen({
      target: "aeon-code-offscreen",
      kind: "cell",
      cellId: run.cellId,
      chatId: run.chatId,
      code: run.code,
      timeoutMs: run.timeoutMs,
      attached: run.targets[0],
    })) as { value?: unknown; output?: string; error?: string; reset?: boolean } | undefined;
    finish(
      cell,
      result ?? {
        output: "",
        error: "INTERNAL: browser runtime did not respond; runtime reset",
        reset: true,
      },
    );
  } catch (error) {
    finish(cell, {
      output: "",
      error: String(error instanceof Error ? error.message : error),
      reset: true,
    });
  }
}

function finish(
  cell: Cell,
  result: { value?: unknown; output?: string; error?: string; reset?: boolean },
): void {
  if (cell.done) return;
  cell.done = true;
  if (cell.progressTimer) clearTimeout(cell.progressTimer);
  // A cell that failed never waits for the hand-offs it started: they end with it.
  if (result.error) endStartedHandoffs(cell.run.cellId);
  finalize(cell, result);
}

function finalize(
  cell: Cell,
  result: { value?: unknown; output?: string; error?: string; reset?: boolean },
): void {
  cells.delete(cell.run.cellId);
  void releaseTabs(cell.guarded);
  for (const waiter of cell.calls.values()) waiter.reject(new Error("Browser cell finished"));
  const used = new Set<number>();
  for (const entry of cell.steps) {
    const target = (entry.action as { target?: { tabId?: unknown } } | undefined)?.target;
    if (typeof target?.tabId === "number") used.add(target.tabId);
  }
  const tabs = currentInventoryTabs();
  const live = new Set(tabs.map((tab) => tab.target.tabId));
  const unused = [...cell.opened.values()].filter(
    (tab) => !used.has(tab.tabId) && live.has(tab.tabId),
  );
  const urlOf = new Map(tabs.map((tab) => [tab.target.tabId, tab.url]));
  const popupsUnused = unusedAgentTabs(cell.run.chatId).filter((tab) => live.has(tab.tabId));
  const note =
    unused.length || popupsUnused.length
      ? `\nNote: ${unused.length + popupsUnused.length} tab${unused.length + popupsUnused.length === 1 ? "" : "s"} you opened were never used (${[
          ...unused.map((tab) => `${tab.tabId} ${urlOf.get(tab.tabId) ?? ""}`),
          ...popupsUnused.map((tab) => `${tab.tabId} ${tab.url}`),
        ].join(", ")}); page.close() or browser.closeTab() closes them.`
      : "";
  send(cell.socket, {
    kind: "browser.code.result",
    cellId: cell.run.cellId,
    output: ((result.output ?? "") + note).slice(0, 1_000_000),
    ...(result.value !== undefined ? { value: result.value } : {}),
    ...(result.error ? { error: result.error.slice(0, 20000) } : {}),
    ...(result.reset ? { reset: true } : {}),
    steps: cell.steps.slice(-MAX_TRACE),
    ms: Math.max(0, Date.now() - (cell.startedAt ?? Date.now())),
    opened: [...cell.opened.values()],
    openedUnused: unused,
    popupsUnused,
    tabStats: (() => {
      const summary = agentTabSummary(cell.run.chatId);
      return { ...summary, popups: Math.max(0, summary.popups - cell.popupsAtStart) };
    })(),
  });
}

// Offscreen relays calls from the sandboxed realm. Only that document may send them.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-host") return;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN)) return;
  if (message.kind === "jobDone") {
    finishJob(message as Record<string, unknown>);
    reply({ ok: true });
    return true;
  }
  if (message.kind === "stage") {
    const cell = cells.get(String(message.cellId));
    const stage = BrowserCodeStageSchema.safeParse(message.stage);
    if (cell && stage.success) sendStage(cell, stage.data);
    reply({ ok: true });
    return true;
  }
  if (message.kind !== "call") return;
  const cell = cells.get(message.cellId) ?? jobs.get(message.cellId);
  if (!cell) {
    reply({ error: "RUN_RESET: browser cell is no longer active" });
    return;
  }
  serve(cell, message.request).then(
    (value) => reply({ value }),
    (error: unknown) => reply({ error: describe(error) }),
  );
  return true;
});

// Non-step requests are kernel effects (code-runtime-effects.ts): the kernel authorizes the tab
// and checks the site each one names before it runs.
const EFFECTS = cellEffects({ callCore, handoff });
const CHECKS: KernelChecks<Cell> = {
  authorize: (cell, target) => authorizedTarget(cell, target).tabId,
  guardTab: (cell, tabId) => guardCellTab(cell, tabId),
  guardSite: async (cell, site) => assertAllowed(await siteRulesFor(cell), site),
};

async function serveCall(cell: Cell, value: Record<string, unknown> | null): Promise<unknown> {
  const done = value ? await runEffect(EFFECTS, CHECKS, cell, value) : undefined;
  // Nothing that reaches agent code carries a password, whatever answered it.
  return scrubSecrets(done ? done.value : await callCore(cell, value));
}

function siteRulesFor(cell: Cell): Promise<SiteRules> {
  cell.siteRules ??= callCore(cell, { siteRules: true })
    .catch(() => NO_RULES)
    .then(combinedRules);
  return cell.siteRules;
}

async function guardCellTab(cell: Cell, tabId: number): Promise<void> {
  await guardTab(tabId, await siteRulesFor(cell));
  cell.guarded.add(tabId);
}

/** A step that goes somewhere, or acts in a tab, stays off blocked sites. */
async function enforceSites(cell: Cell, step: BrowserStep): Promise<void> {
  const rules = await siteRulesFor(cell);
  assertAllowed(rules, (step as { url?: unknown }).url);
  const target = (step as { target?: { tabId?: unknown } }).target;
  if (typeof target?.tabId === "number") await guardCellTab(cell, target.tabId);
}

async function serve(cell: Cell, request: unknown): Promise<unknown> {
  const value = request as Record<string, unknown> | null;
  if (!value || typeof value.op !== "string") return serveCall(cell, value);
  const step = await prepare(cell, value);
  authorize(cell, step);
  await enforceSites(cell, step);
  noteAgentText(step);
  const entry: Record<string, unknown> = {
    index: cell.steps.length,
    action: step,
    disposition: "running",
    tStart: Date.now(),
  };
  cell.steps.push(entry);
  progress(cell);
  const stepTab = "target" in step ? step.target.tabId : undefined;
  if (stepTab !== undefined) takeActionTiming(stepTab);
  let resultTab: number | undefined;
  if (isSubmitLike(step) && "target" in step) await beforeSubmit(cell, step.target.tabId);
  try {
    const result = await scrubSecrets(
      await executeLocalBrowserStep(
        cell.identity,
        cell.run.chatId,
        cell.run.toolCallId,
        cell.operationId,
        step,
      ),
    );
    if (result.kind === "tab") {
      await guardCellTab(cell, result.tab.target.tabId);
      const key = targetIdentity(result.tab.target);
      cell.allowed.set(key, result.tab.target);
      cell.opened.set(key, result.tab.target);
    }
    Object.assign(entry, { disposition: "completed", result });
    if ("target" in step) hideTypedPassword(cell, step.target.tabId);
    const tabId = (resultTab =
      result.kind === "tab"
        ? result.tab.target.tabId
        : "target" in step
          ? step.target.tabId
          : undefined);
    if (tabId !== undefined) {
      if (isSubmitLike(step) && "target" in step) await vaultAfterSubmit(cell, step.target, result);
      void notePreviewActivity(cell.run.chatId, tabId);
      // Only work in a tab (not reads) brings its chat and the tab together in Split View.
      if (presentsBrowserTask(step.op) && !("present" in step && step.present === false))
        void presentBrowserTask(cell.run.chatId, tabId);
    }
    recordScreenshot(cell, step, result);
    return result;
  } catch (error) {
    // An input step that did not run says so in the closed effect vocabulary too: refused,
    // with its code as the evidence. The step line the model reads is unchanged.
    const refused = INPUT_OPS.has(step.op) ? refusedEffect(errorCode(error)) : undefined;
    Object.assign(entry, {
      disposition: "failed",
      code: describe(error),
      ...(refused ? { effect: refused.effect, evidence: refused.evidence } : {}),
    });
    throw await scrubError(await stepFailure(step, error));
  } finally {
    entry.tEnd = Date.now();
    entry.ms = Math.max(0, Number(entry.tEnd) - Number(entry.tStart ?? entry.tEnd));
    const tabId = resultTab ?? stepTab;
    if (tabId !== undefined)
      Object.assign(entry, await stepTrace(tabId, INPUT_OPS.has(step.op)).catch(() => ({})));
    recordStep(cell.events, {
      cellId: cell.run.cellId,
      chatId: cell.run.chatId,
      index: typeof entry.index === "number" ? entry.index : cell.events.length,
      step,
      entry,
    });
    progress(cell);
  }
}

/** Keeps a password a person typed, and matches Chrome's own save offer to the profile's manager. */
async function beforeSubmit(cell: Cell, tabId: number): Promise<void> {
  // Probing attaches the debugger, which costs a click its popup: skip tabs the agent typed nothing
  // in (a person's login during a hand-off is caught by the hand-off itself).
  if (agentTypedIn(tabId) && !vaultCandidate(tabId))
    await captureTypedPassword(tabId).catch(() => undefined);
  // Keyboard typing carries the value in its step; the trace never keeps a password.
  hideTypedPassword(cell, tabId);
  const candidate = vaultCandidate(tabId);
  if (candidate)
    await matchChromeSaving((request) => callCore(cell, request), candidate.url).catch(
      () => undefined,
    );
}

/**
 * Replaces the password a step typed (fill, keyboard.type, pressSequentially, paste) with a marker
 * in the trace. The value is learned when the submit probes the form, so this runs over the steps
 * already recorded, not only the current one.
 */
function hideTypedPassword(cell: Cell, tabId: number): void {
  const secret = vaultCandidate(tabId)?.password;
  if (!secret) return;
  const holds = (text: string) => text === secret || (secret.length >= 4 && text.includes(secret));
  for (const entry of cell.steps) {
    if (entry.disposition === "running") continue;
    const action = entry.action as Record<string, unknown> | undefined;
    if (!action) continue;
    for (const field of ["value", "keys", "text"])
      if (typeof action[field] === "string" && holds(action[field]))
        action[field] = "[hidden password]";
  }
}

/**
 * Saves a login the agent typed once its form went through. The capture waits for the page's own
 * answer (a form that stays a few seconds before it moves still counts), because the host call
 * that saves belongs to this cell: returning first and saving later lost slow successes when the
 * cell was already gone. When no password manager took it, only Chrome's own "Save password?"
 * prompt can keep it, and agent code cannot click browser UI, so the kernel asks the user itself
 * and no model can skip it. With no manager set up the answer is instant: the click waits for the
 * user and its note says how it went.
 */
async function vaultAfterSubmit(
  cell: Cell,
  target: { tabId: number },
  result: unknown,
): Promise<void> {
  if (!vaultCandidate(target.tabId)) return;
  // Before the post-submit probes. The unlock hand-off is decided only after they return, and a
  // stuck probe must not hide the flag the page is already being asked to show.
  await publishHandoffWaiting(target.tabId);
  const outcome = await finishVaultCapture(target.tabId, (request) =>
    callCore(cell, request),
  ).catch(() => undefined);
  // Every outcome is said on the click itself, so the model never has to check a save.
  if (outcome === "saved") {
    await dismissHandoffPage(target.tabId);
    return addNote(result, VAULT_SAVED);
  }
  if (outcome === "failed") return addNote(result, await askToUnlock(cell, target));
  // Nothing saved (no answer, skipped or a person's own password): nothing to say.
  if (outcome !== "unsaved") {
    await dismissHandoffPage(target.tabId);
    return;
  }
  const asked = await handoff(cell, { target, message: SAVE_IN_CHROME }).catch(() => "failed");
  addNote(result, asked === "done" ? UNSAVED_LOGIN_SAVED : UNSAVED_LOGIN_NOTE);
}

function addNote(result: unknown, note: string): void {
  const action = result as { kind?: string; note?: string };
  if (action.kind === "action") action.note = action.note ? `${action.note}; ${note}` : note;
}

/**
 * The password manager is set up but could not save (locked, or its CLI did not answer). Chrome's
 * prompt is off while a manager is set up, so the login would be lost: the kernel asks the user to
 * unlock it and saves it again on Done.
 */
async function askToUnlock(cell: Cell, target: { tabId: number }): Promise<string> {
  const provider = failedSave(target.tabId);
  if (!provider) return MANAGER_DID_NOT_SAVE;
  const asked = await handoff(cell, { target, message: unlockToSave(provider) }).catch(
    () => "cancelled",
  );
  if (asked !== "done") return MANAGER_DID_NOT_SAVE;
  const saved = await retryVaultSave(target.tabId, (request) => callCore(cell, request));
  return saved ? SAVED_AFTER_UNLOCK : MANAGER_DID_NOT_SAVE;
}

/**
 * A login the user finished themselves during a hand-off (the agent asked them to sign in) is
 * saved like one the agent made; with no manager, Chrome's own prompt already asked them.
 */
async function saveUserLogin(cell: Cell, target: { tabId: number }): Promise<void> {
  if (vaultCandidate(target.tabId)?.source !== "user") return;
  const outcome = await finishVaultCapture(target.tabId, (request) =>
    callCore(cell, request),
  ).catch(() => undefined);
  if (outcome === "failed") await askToUnlock(cell, target);
}

/**
 * A step that may submit a password form. Clicks by id, Playwright-style clicks (pointer steps at
 * the element's point) and Enter all count: naming only buttons called "Continue" missed the
 * clicks agents mostly make, and their logins were never saved. A click on a page with no
 * password form costs one quick probe and saves nothing.
 */
function isSubmitLike(step: BrowserStep): boolean {
  if (step.op === "press") return /^(Enter|NumpadEnter)$/i.test(step.key);
  if (step.op === "keys") return /\n|\r|\{?Enter\}?/i.test(step.keys);
  if (step.op === "pointer") return step.action === "click" || step.action === "doubleClick";
  if (step.op !== "click") return false;
  const element = step.element;
  if (element.kind === "locator" && element.role !== "button") return element.role === "link";
  return true;
}

// Steps whose trace entries carry input timing, pixel ratio included.
const INPUT_OPS = new Set([
  "click",
  "fill",
  "press",
  "scroll",
  "navigate",
  "openTab",
  "pointer",
  "keys",
]);

// A hand-off started ahead ({start}: before a click that opens a passkey, 2FA or payment prompt
// the page then blocks on) keeps waiting after its cell; the next bu.handoff on the tab waits for it.
const startedHandoffs = new Map<
  number,
  { token: object; run: Promise<"done" | "cancelled">; cellId: string }
>();
// A started hand-off nobody waits for ends on its own after this long.
const STARTED_LIMIT_MS = 10 * 60_000;

function endStartedHandoffs(cellId: string): void {
  for (const [tabId, started] of startedHandoffs)
    if (started.cellId === cellId) startedHandoffs.delete(tabId);
}

async function handoff(cell: Cell, request: object): Promise<unknown> {
  const { message, start, cancel, spotlight } = request as {
    message?: unknown;
    start?: unknown;
    cancel?: unknown;
    spotlight?: { x: number; y: number; width: number; height: number };
  };
  const target = authorizedTarget(cell, (request as { target?: unknown }).target);
  const pending = startedHandoffs.get(target.tabId);
  if (cancel === true) {
    startedHandoffs.delete(target.tabId);
    return { cancelled: Boolean(pending) };
  }
  if (pending && start !== true) return waitForStarted(cell, target.tabId, pending.run);
  // Before Split View takes the window lock. The page flag does not need that lock or the debugger.
  await publishHandoffWaiting(target.tabId);
  void notePreviewActivity(cell.run.chatId, target.tabId);
  // The user needs to see the tab: pair it beside its Chat in Split View, whatever the view setting.
  void presentBrowserTask(cell.run.chatId, target.tabId, true);
  const text = String(message ?? "").slice(0, 500) || "Please take over, then click Done.";
  const entry: Record<string, unknown> = {
    index: cell.steps.length,
    action: { op: "handoff", message: text, target, ...(start === true ? { start: true } : {}) },
    disposition: "running",
  };
  cell.steps.push(entry);
  const box = spotlight && Number.isFinite(spotlight.x) ? spotlight : undefined;
  if (start === true) {
    const token = {};
    const run = handOffToUser(
      target.tabId,
      text,
      () => startedHandoffs.get(target.tabId)?.token === token,
      box,
    );
    startedHandoffs.set(target.tabId, { token, run, cellId: cell.run.cellId });
    setTimeout(() => {
      if (startedHandoffs.get(target.tabId)?.token === token) startedHandoffs.delete(target.tabId);
    }, STARTED_LIMIT_MS);
    void run.then(
      (outcome) =>
        Object.assign(entry, { disposition: outcome === "done" ? "completed" : "failed" }),
      (error: unknown) => Object.assign(entry, { disposition: "failed", code: describe(error) }),
    );
    return { started: true };
  }
  setWaiting(cell, true);
  try {
    const outcome = await handOffToUser(target.tabId, text, () => !cell.done, box);
    Object.assign(entry, { disposition: outcome === "done" ? "completed" : "failed" });
    if (outcome === "done") await saveUserLogin(cell, target);
    return answered(target.tabId, outcome);
  } catch (error) {
    Object.assign(entry, { disposition: "failed", code: describe(error) });
    throw error;
  } finally {
    setWaiting(cell, false);
  }
}

/** A hand-off the user answered by typing into the cursor returns that text. */
function answered(
  tabId: number,
  outcome: "done" | "cancelled",
): "done" | "cancelled" | { answer: string } {
  const answer = outcome === "done" ? takeTypedAnswer(tabId) : undefined;
  return answer !== undefined ? { answer } : outcome;
}

async function waitForStarted(
  cell: Cell,
  tabId: number,
  run: Promise<"done" | "cancelled">,
): Promise<"done" | "cancelled" | { answer: string }> {
  setWaiting(cell, true);
  try {
    const outcome = await run;
    if (outcome === "done") await saveUserLogin(cell, { tabId });
    return answered(tabId, outcome);
  } finally {
    setWaiting(cell, false);
    if (startedHandoffs.get(tabId)?.run === run) startedHandoffs.delete(tabId);
  }
}

/** A target from a local request, held to the same ownership rules as browser steps. */
function authorizedTarget(cell: Cell, target: unknown): BrowserTargetKey {
  const parsed = BrowserStepSchema.safeParse({ op: "observe", kind: "semantic", target });
  if (!parsed.success || parsed.data.op !== "observe") throw new Error("INVALID_TARGET");
  authorize(cell, parsed.data);
  return parsed.data.target;
}

/** One line saying how far the cell got; Core names it if the deadline fires. */
function sendStage(cell: Cell, stage: BrowserCodeStage): void {
  if (cell.done) return;
  send(cell.socket, {
    kind: "browser.code.progress",
    cellId: cell.run.cellId,
    steps: progressSteps(cell),
    stage,
  });
}

// Sent at once rather than throttled: Core pauses or restarts the cell deadline on it.
function setWaiting(cell: Cell, waiting: boolean): void {
  cell.waitingForUser = waiting;
  if (cell.done) return;
  send(cell.socket, {
    kind: "browser.code.progress",
    cellId: cell.run.cellId,
    steps: progressSteps(cell),
    waitingForUser: waiting,
  });
}

async function prepare(cell: Cell, value: Record<string, unknown>): Promise<BrowserStep> {
  if (++cell.count > MAX_STEPS)
    throw new Error(
      `INVALID_INPUT: one cell may run ${MAX_STEPS} browser steps; split the work across cells`,
    );
  if (value.op === "openTab" && !value.clientInstanceId)
    value.clientInstanceId = cell.identity.clientInstanceId;
  if (value.op === "openTab" && value.space === undefined)
    value.space =
      value.quiet === true
        ? "window"
        : (cell.run.space ?? engineConfig.defaultSpace(cell.run.chatId));
  if (value.op === "upload" && Array.isArray(value.files))
    value.files = await callCore(cell, { validateUpload: value.files });
  const parsed = BrowserStepSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // The model's arguments did not fit the step: name the field, so it can fix that one.
  const issues = parsed.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message)
    .join("; ");
  throw new Error(`INVALID_INPUT: ${String(value.op)} ${issues}`.slice(0, 400));
}

function authorize(cell: Cell, step: BrowserStep): void {
  if (step.op === "listTabs" || step.op === "openTab") return;
  const target = step.target;
  if (target.clientInstanceId !== cell.identity.clientInstanceId) throw new Error("TARGET_LOST");
  const key = targetIdentity(target);
  if (cell.allowed.has(key) || browserSessionOwner(target.tabId) === cell.run.chatId) return;
  // Any open tab is the agent's to use, no attaching needed: the first step in it attaches it.
  // A blocked site still answers SITE_BLOCKED (enforceSites runs next).
  if (!currentInventoryTabs().some((tab) => targetIdentity(tab.target) === key))
    throw new Error(`TARGET_LOST: tab ${target.tabId} is not open; browser.tabs() lists open tabs`);
  cell.allowed.set(key, target);
  cell.opened.set(key, target);
}

function recordScreenshot(cell: Cell, step: BrowserStep, result: unknown): void {
  if (step.op !== "cdp" || step.method !== "Page.captureScreenshot") return;
  const data = (result as { data?: { value?: { data?: unknown } } }).data?.value?.data;
  if (typeof data !== "string") return;
  const format = (step.params as { format?: string } | undefined)?.format;
  cell.steps.push({
    result: {
      kind: "screenshot",
      screenshotId: crypto.randomUUID(),
      dataBase64: data,
      mimeType: format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png",
    },
  });
}

function callCore(cell: Cell, request: unknown): Promise<unknown> {
  const callId = String(++cell.sequence);
  return new Promise((resolve, reject) => {
    cell.calls.set(callId, { resolve, reject });
    if (
      !send(cell.socket, { kind: "browser.code.call", cellId: cell.run.cellId, callId, request })
    ) {
      cell.calls.delete(callId);
      reject(
        new Error(
          cell.socket.readyState === WebSocket.OPEN
            ? "TOO_LARGE: this call carries over 3.5 MB; split the data into smaller pieces"
            : "BROWSER_OFFLINE",
        ),
      );
    }
  });
}

function progress(cell: Cell): void {
  if (cell.progressTimer) return;
  cell.progressTimer = setTimeout(() => {
    cell.progressTimer = undefined;
    if (cell.done) return;
    send(cell.socket, {
      kind: "browser.code.progress",
      cellId: cell.run.cellId,
      steps: progressSteps(cell),
    });
  }, 150);
}

// Progress is for the live activity view; images and full observations wait for the result.
function progressSteps(cell: Cell): Record<string, unknown>[] {
  return cell.steps.slice(-MAX_TRACE).map(({ result, ...rest }) => ({
    ...rest,
    ...(result ? { result: { kind: (result as { kind?: unknown }).kind } } : {}),
  }));
}

// The bridge accepts frames up to 32 MB. A cell that returns more is refused here so the failure
// is its own message (a result drops its value, a call fails alone) instead of a closed socket.
const MAX_MESSAGE_CHARS = 24_000_000;
function send(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  let text = JSON.stringify(message);
  const limit = MAX_MESSAGE_CHARS;
  if (text.length > limit) {
    const result = message as { kind?: string; value?: unknown; steps?: unknown[] };
    if (result.kind !== "browser.code.result") return false;
    const size = (text.length / 1_000_000).toFixed(1);
    text = JSON.stringify({
      ...result,
      value: undefined,
      steps: [],
      output: "",
      error: `RESULT_TOO_LARGE: the result was ${size} MB. Return less, or write it with artifact(name, data) and return a summary.`,
    });
  }
  socket.send(text);
  return true;
}

function describe(error: unknown): string {
  const code = errorCode(error);
  const detail = browserErrorDetail(error);
  const message = error instanceof Error ? error.message : String(error);
  const text =
    detail ??
    (message.startsWith(code) ? message.slice(code.length).replace(/^:\s*/, "") : message);
  return describeKernelError(code, text, browserErrorContext(error));
}
