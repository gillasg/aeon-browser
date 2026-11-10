// JavaScript dialogs are answered at once: the renderer is frozen until Page.handleJavaScriptDialog.
// The page does not choose. Alert is accepted. A confirm or prompt is accepted only when the agent
// acted in this tab in the last 5s (a prompt keeps the page's default text); otherwise it is
// dismissed and the model gets a [warn] line. beforeunload is accepted only when this navigation
// was started by the agent in a tab the agent opened. page.dialog.expect sets the next answer.
import type { BrowserExecutorResult, BrowserStep } from "@browserkit/protocol";
import { refreshInventoryTab } from "../native-inventory-client.js";
import { safePage, sameTarget } from "../native-browser-common.js";
import { notePageConsole } from "../native-browser-events.js";
import { noteReceiptDialog } from "../native-browser-receipts.js";
import { send } from "../cdp/send.js";
import { onEngineInstall } from "../native-engine-install.js";

/** Confirm/prompt counts as asked only inside this window after an agent action. */
export const DIALOG_ACT_MS = 5_000;
/** beforeunload belongs to a navigation only for this long after the agent started it. */
export const DIALOG_NAV_MS = 1_500;

const ACT_OPS = new Set([
  "click",
  "press",
  "fill",
  "paste",
  "keys",
  "pointer",
  "upload",
  "navigate",
  "evaluate",
  "cdp",
  "scroll",
]);
const NAV_OPS = new Set(["navigate", "click", "press"]);

export interface DialogInput {
  type: string;
  message: string;
  defaultPrompt?: string;
  actedWithin: boolean;
  agentOpenedTab: boolean;
  agentStartedNavigation: boolean;
  expected?: string;
}
export interface DialogDecision {
  accept: boolean;
  promptText: string;
  type: string;
  message: string;
  /** A [warn] line for the model, when the page's dialog was refused. */
  warn?: string;
  line: string;
}

const actedAt = new Map<number, number>();
const navigatedAt = new Map<number, number>();
const expected = new Map<number, string>();
const warns = new Map<number, string[]>();
let agentOpened: (tabId: number) => boolean = () => false;

/** Tabs the agent opened, as opposed to the user's. Popups the page opened do not count. */
export function setAgentOpenedTab(read: (tabId: number) => boolean): void {
  agentOpened = read;
}

export function noteDialogAct(tabId: number, now = Date.now()): void {
  actedAt.set(tabId, now);
}

/** The agent started a navigation in this tab (goto, or a click or key that can leave). */
export function noteAgentNavigation(tabId: number, now = Date.now()): void {
  navigatedAt.set(tabId, now);
  actedAt.set(tabId, now);
}

export function noteDialogActivity(step: BrowserStep): void {
  if (!("target" in step)) return;
  const tabId = step.target.tabId;
  if (ACT_OPS.has(step.op)) noteDialogAct(tabId);
  if (NAV_OPS.has(step.op) || (step.op === "cdp" && step.method === "Page.navigate"))
    noteAgentNavigation(tabId);
}

/** The next dialog in this tab uses this answer, once: "dismiss", "accept", or prompt text. */
export function expectNextDialog(tabId: number, answer: string): void {
  expected.set(tabId, answer.slice(0, 500));
}

export function takeDialogWarns(tabId: number): string | undefined {
  const lines = warns.get(tabId);
  warns.delete(tabId);
  if (!lines?.length) return undefined;
  return lines.join("\n");
}

export function decideDialog(input: DialogInput): DialogDecision {
  const message = clip(input.message, 300);
  const type = (input.type || "alert").slice(0, 40);
  if (input.expected !== undefined) return fromExpect(type, message, input);
  if (type === "alert") return accept(type, message, "");
  if (type === "beforeunload") return leaveDialog(type, message, input);
  if (input.actedWithin) return accept(type, message, input.defaultPrompt ?? "");
  return dismiss(type, message, unaskedWarn(type, message));
}

export function answerDialogOpening(
  tabId: number,
  raw: { type?: string; message?: string; defaultPrompt?: string },
  now = Date.now(),
  opened?: boolean,
): DialogDecision {
  const pending = takeExpected(tabId);
  const decision = decideDialog({
    type: raw.type ?? "",
    message: String(raw.message ?? ""),
    ...(raw.defaultPrompt !== undefined ? { defaultPrompt: raw.defaultPrompt } : {}),
    actedWithin: within(actedAt.get(tabId), now, DIALOG_ACT_MS),
    agentOpenedTab: opened ?? agentOpened(tabId),
    agentStartedNavigation: within(navigatedAt.get(tabId), now, DIALOG_NAV_MS),
    ...(pending !== undefined ? { expected: pending } : {}),
  });
  noteReceiptDialog(tabId, {
    type: decision.type,
    message: decision.message,
    accepted: decision.accept,
  });
  notePageConsole(tabId, decision.warn ? "warning" : "info", decision.line);
  if (decision.warn) pushWarn(tabId, decision.warn);
  return decision;
}

/** Records the expectation, then returns it as a page result the sandbox can read. */
export async function dialogExpectResult(
  step: Extract<BrowserStep, { op: "dialog" }>,
): Promise<BrowserExecutorResult> {
  expectNextDialog(step.target.tabId, step.expect);
  const tab = await refreshInventoryTab(step.target.tabId);
  if (!tab || !sameTarget(tab.target, step.target) || !safePage(tab.url))
    throw new Error("TARGET_LOST");
  return {
    kind: "page",
    source: "website",
    trust: "untrusted",
    target: tab.target,
    documentEpoch: tab.documentEpoch,
    url: tab.url,
    data: { expect: step.expect },
  };
}

/** Puts a queued [warn] on the step the model is about to read. */
export function withDialogWarn(
  result: BrowserExecutorResult,
  tabId: number,
): BrowserExecutorResult {
  const warn = takeDialogWarns(tabId);
  if (!warn) return result;
  if (result.kind === "action") return actionWarn(result, warn);
  if (result.kind === "page" && isRecord(result.data))
    return { ...result, data: { ...result.data, dialogWarn: warn } };
  return result;
}

export function onJavaScriptDialog(
  source: chrome.debugger.Debuggee,
  method: string,
  raw: unknown,
): void {
  if (source.tabId === undefined || method !== "Page.javascriptDialogOpening") return;
  const data = (raw ?? {}) as { type?: string; message?: string; defaultPrompt?: string };
  const decision = answerDialogOpening(source.tabId, data);
  void send(
    source,
    "Page.handleJavaScriptDialog",
    { accept: decision.accept, promptText: decision.promptText },
    { label: "onJavaScriptDialog" },
  ).catch(() => undefined);
}

function fromExpect(type: string, message: string, input: DialogInput): DialogDecision {
  if (input.expected === "dismiss") return dismiss(type, message);
  const promptText =
    input.expected === "accept" ? (input.defaultPrompt ?? "") : (input.expected ?? "");
  return accept(type, message, promptText);
}

function leaveDialog(type: string, message: string, input: DialogInput): DialogDecision {
  if (input.agentOpenedTab && input.agentStartedNavigation) return accept(type, message, "");
  return dismiss(type, message, leaveWarn(message));
}

function accept(type: string, message: string, promptText: string): DialogDecision {
  return {
    accept: true,
    promptText,
    type,
    message,
    line: `[dialog ${type}] ${message} (accepted)`,
  };
}

function dismiss(type: string, message: string, warn?: string): DialogDecision {
  return {
    accept: false,
    promptText: "",
    type,
    message,
    ...(warn ? { warn } : {}),
    line: warn ?? `[dialog ${type}] ${message} (dismissed)`,
  };
}

function unaskedWarn(type: string, message: string): string {
  const text = clip(message, 160);
  return `[warn] the page opened a ${type} ("${text}") on its own; Aeon dismissed it. To answer the next one, await page.dialog.expect("accept") or page.dialog.expect("the text") first.`;
}

function leaveWarn(message: string): string {
  const text = clip(message, 160);
  return `[warn] the page asked to leave ("${text}"); Aeon stayed because this is the user's tab or you did not start the navigation. To leave, await page.dialog.expect("accept") first.`;
}

function actionWarn(
  result: Extract<BrowserExecutorResult, { kind: "action" }>,
  warn: string,
): BrowserExecutorResult {
  const note = result.note ? `${warn} ${result.note}` : warn;
  return { ...result, note: note.slice(0, 1000) };
}

function takeExpected(tabId: number): string | undefined {
  const answer = expected.get(tabId);
  expected.delete(tabId);
  return answer;
}

function within(at: number | undefined, now: number, windowMs: number): boolean {
  return at !== undefined && now - at >= 0 && now - at < windowMs;
}

function pushWarn(tabId: number, line: string): void {
  const lines = warns.get(tabId) ?? [];
  lines.push(line);
  if (lines.length > 6) lines.shift();
  warns.set(tabId, lines);
}

function clip(message: string, max: number): string {
  return message.replace(/\s+/g, " ").trim().slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forgetDialog(tabId: number): void {
  actedAt.delete(tabId);
  navigatedAt.delete(tabId);
  expected.delete(tabId);
  warns.delete(tabId);
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener(onJavaScriptDialog);
  chrome.tabs.onRemoved.addListener(forgetDialog);
});
