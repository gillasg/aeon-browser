import { BrowserActionError, type AxRef } from "./native-browser-common.js";
import type { BrowserElementTarget } from "@browserkit/protocol";
import { nodeState, onNode } from "./native-browser-dom.js";
import { coveringElement, hitPoint, scrollNearest } from "./native-browser-input-page.js";
import { pageStillChanging } from "./native-browser-navigation.js";
import { browserObservationRefs } from "./native-browser-observation.js";
import { hiddenTargetError } from "./native-browser-reveal.js";
import {
  foreignLoginHost,
  foreignLoginMessage,
  loginFormOfNode,
} from "./native-browser-profile.js";
import { send } from "./cdp/send.js";

// Getting an element ready for input: the point a click or fill uses, and the retry rules that
// keep every attempt inside the step's one deadline.
export interface Point {
  x: number;
  y: number;
  activate?: boolean;
}
export async function actionablePoint(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  editable = false,
  force = false,
  deadline?: number,
): Promise<Point> {
  await send(
    debuggee,
    "DOM.scrollIntoViewIfNeeded",
    { backendNodeId: id },
    {
      label: "actionablePoint",
    },
  );
  await onNode(debuggee, id, scrollNearest).catch(() => undefined);
  const state = await onNode<{
    visible: boolean;
    enabled: boolean;
    editable: boolean;
    file: boolean;
    textEntry?: boolean;
  }>(debuggee, id, nodeState);
  // Before any pointer event: a click here would open the OS file dialog.
  if (state.file) throw new Error("FILE_INPUT");
  if (!state.visible) throw await hiddenTargetError(debuggee, id);
  if (!state.enabled) throw new Error("TARGET_DISABLED");
  if (editable && !state.editable) throw new Error("NOT_EDITABLE");
  // A fill focuses the control programmatically, so it needs no stable click point; it still
  // checks once that nothing covers the control, which is the only part of the pointer test a
  // fill needs. The 50 ms stability loop stays for clicks.
  // Only a text-entry control is hit-tested; a select takes its value directly, and
  // {force: true} skips the cover check (visible, enabled and editable still hold).
  if (editable) {
    const point = await onNode<Point & { hit: boolean }>(debuggee, id, hitPoint);
    if (!point.hit && state.textEntry !== false && !force) {
      const cover = await onNode<string>(debuggee, id, coveringElement).catch(() => "");
      throw new BrowserActionError("TARGET_BLOCKED", coveredFieldMessage(cover));
    }
    return { x: point.x, y: point.y };
  }
  let prior: Point | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await onNode<Point & { hit: boolean }>(debuggee, id, hitPoint);
    const stable = prior && Math.abs(current.x - prior.x) < 1 && Math.abs(current.y - prior.y) < 1;
    if (stable && current.hit)
      return { x: current.x, y: current.y, ...(current.activate ? { activate: true } : {}) };
    prior = current;
    if (deadline !== undefined && Date.now() >= deadline) break;
    const wait = deadline !== undefined ? Math.min(50, Math.max(0, deadline - Date.now())) : 50;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const cover = await onNode<string>(debuggee, id, coveringElement).catch(() => "");
  throw cover ? new BrowserActionError("TARGET_BLOCKED", cover) : new Error("TARGET_BLOCKED");
}
/** "Can't reach the field: covered by dialog "Cookies". Close it first, or pass {force: true}." */
export function coveredFieldMessage(cover: string): string {
  const what = cover.split("; ")[0]?.trim() || "another element";
  return `Can't reach the field: ${what}. Close it first, or pass {force: true}.`;
}

/** A step's time budget when it names none: one deadline for every retry inside it. */
export const DEFAULT_STEP_MS = 5_000;

/** The ref's recorded role and name, as a locator, when the ref itself went stale. */
export function relocateRef(
  element: BrowserElementTarget,
  error: unknown,
): BrowserElementTarget | undefined {
  if (element.kind !== "ref" || !(error instanceof Error) || error.message !== "STALE_REF")
    return undefined;
  const prior = browserObservationRefs.refs.get(element.snapshotId)?.get(element.ref);
  if (!prior?.role || !prior.name) return undefined;
  return { kind: "locator", role: prior.role, name: prior.name, exact: true };
}

// A missing target is retried only while the page is still changing, abandoned after 500 ms
// quiet, and never past the step's deadline.
export async function holdMissingTarget(
  debuggee: chrome.debugger.Debuggee,
  error: unknown,
  clock: { deadline: number; quietSince: number; seen: number | undefined },
  changing: typeof pageStillChanging = pageStillChanging,
): Promise<boolean> {
  if (!(error instanceof Error) || error.message !== "TARGET_NOT_FOUND") return false;
  const moving = await changing(debuggee, clock.seen);
  clock.seen = moving.changes;
  if (moving.active) clock.quietSince = Date.now();
  const quiet = Date.now() - clock.quietSince >= 500;
  const capped = Date.now() >= clock.deadline;
  if (quiet || capped) throw error;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return true;
}

export function retryablePreparation(error: Error, element: BrowserElementTarget): boolean {
  if (["TARGET_NOT_FOUND", "TARGET_HIDDEN", "TARGET_BLOCKED"].includes(error.message)) return true;
  return (
    element.kind !== "ref" &&
    (error.message === "STALE_REF" ||
      /could not find node|no node with|context.*destroyed|cannot find context/i.test(
        error.message,
      ))
  );
}

export function normalizePreparationError(error: unknown): unknown {
  if (
    error instanceof Error &&
    /could not find node|no node with|context.*destroyed|cannot find context/i.test(error.message)
  )
    return new Error("STALE_REF");
  return error;
}

export async function refuseForeignLoginForm(
  frame: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<void> {
  const form = await onNode<{ page: string; action: string | null } | null>(
    frame,
    backendNodeId,
    loginFormOfNode,
  ).catch(() => null);
  const host = form ? foreignLoginHost(form.page, form.action) : null;
  if (host) throw new BrowserActionError("FOREIGN_FORM", foreignLoginMessage(host));
}
