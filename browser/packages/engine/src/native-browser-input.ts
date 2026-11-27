import { measureBox, noteActionTiming } from "./native-browser-action-timing.js";
import {
  actionablePoint,
  coveredFieldMessage,
  DEFAULT_STEP_MS,
  holdMissingTarget,
  normalizePreparationError,
  refuseForeignLoginForm,
  relocateRef,
  retryablePreparation,
  type Point,
} from "./native-browser-input-ready.js";
export { actionablePoint, coveredFieldMessage, DEFAULT_STEP_MS, holdMissingTarget };
import {
  beginAction,
  deliveredThroughDialog,
  dialogsDuringAction,
  endAction,
  noteDialogAct,
  type AnsweredDialog,
} from "./evidence/dialogs.js";
import { showAgentCursor, showAgentKeys, type CursorUpdate } from "./native-browser-cursor.js";
import {
  fillTextNode,
  isStaleBeforeInsert,
  nodeState,
  onNode,
  readFieldValue,
  staleBeforeInsert,
  type FillVia,
} from "./native-browser-dom.js";
import {
  beginReceipt,
  dropReceipt,
  finishReceipt,
  noteActionStart,
  takeReceipt,
} from "./native-browser-receipts.js";
import "./native-browser-download-reissue.js";
import { labelForAction } from "./evidence/label.js";
import { focusFilledPassword, noteVaultFill } from "./native-browser-vault.js";
import { withFocusEmulation } from "./native-browser-session.js";
import { humanType, paceKey } from "./native-browser-human-input.js";
import { pasteNode } from "./native-browser-paste.js";
import {
  type BrowserExecutorRequest,
  type BrowserElementTarget,
  type BrowserStep,
  BrowserExecutorResultSchema,
  type BrowserExecutorResult,
} from "@browserkit/protocol";
import {
  resolveElement,
  clickAt,
  deliverAt,
  pointerPress,
  pointHold,
  getViewportCenter,
  scrollAt,
  withDebugger,
} from "./native-browser-debugger.js";
import {
  browserObservationRefs,
  screenshotPoint,
  observeSemantic,
} from "./native-browser-observation.js";
import { type AxRef, BrowserActionError, drivablePage } from "./native-browser-common.js";
import {
  elementQuery,
  expectedValue,
  inputStepEffect,
  scrollEffect,
  silentClickNote,
} from "./native-browser-effect.js";
import { childHandlerPoint } from "./native-browser-child-click.js";
import {
  activateNode,
  coveringElement,
  framePoint,
  hitPoint,
  scrollNearest,
} from "./native-browser-input-page.js";
import {
  viewportFingerprint,
  primeBrowserSettle,
  settleBrowserPage,
  pageOutcome,
  pageStillChanging,
} from "./native-browser-navigation.js";
import { resolveFrameObject, rootFramePoint } from "./native-browser-frames.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { scrollWithFeedback } from "./native-browser-scroll.js";
import { hiddenTargetError } from "./native-browser-reveal.js";
import { send } from "./cdp/send.js";
import { dispatchPointer } from "./native-browser-pointer.js";
import { KEY_CODES, KEY_MASKS } from "./native-browser-keys.js";

// A field whose value the password vault may need: a password, or the identity beside it. Other
// fields do not pay the form probe; an unnamed control always does, since its shape is unknown.
const VAULT_FIELD =
  /password|passcode|one[- ]?time|\botp\b|verification code|security code|email|username|user|login|account|identifier|phone|mobile/i;

export function vaultField(name: string | undefined): boolean {
  return !name || VAULT_FIELD.test(name);
}

/** A field that holds a secret: only these need the strict empty check, not a prefilled username. */
function isSecretField(this: HTMLElement): boolean {
  const field = this as HTMLInputElement;
  return (
    field.tagName === "INPUT" &&
    (field.type === "password" || /one-time-code|\botp\b|2fa|mfa/i.test(field.autocomplete ?? ""))
  );
}

/** Clears a credential field we are about to (re)fill, so a later focus refill is distinguishable. */
function clearCredentialField(this: HTMLInputElement): void {
  this.value = "";
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}

/** A credential field must be empty before typing: a letterless mask (••••) still counts as empty. */
export function credentialFieldEmpty(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.trim() === "" || /^[^\p{L}\p{N}]+$/u.test(value);
}

/** Fills a control and returns the value it read back, when that is the value it set. */
export async function fillNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  value: string,
  options: { vault?: boolean } = {},
): Promise<{ readback?: string; via: FillVia }> {
  // A control's focus handler runs only while its document is the focused one, and a combobox
  // can move focus into a replacement input there. Graft fills tabs the user is not looking at,
  // so emulate focus for the fill or the value lands in an input we never measured.
  return withFocusEmulation(debuggee.tabId, async () => {
    // A page script that refills a credential field on focus can make a planted value look like one
    // the user typed. Clear the field (a re-fill of the same password is legitimate), focus it so
    // any focus handler runs, then re-read: a non-empty value now was planted, so refuse and never
    // submit. The usual retained() check still guards the value after typing.
    if (
      options.vault !== false &&
      (await onNode<boolean>(debuggee, id, isSecretField).catch(() => false))
    ) {
      await onNode(debuggee, id, clearCredentialField).catch(() => undefined);
      await focusNode(debuggee, id).catch(() => undefined);
      const afterFocus = await readFieldValue(debuggee, id);
      if (!credentialFieldEmpty(afterFocus))
        throw new BrowserActionError(
          "NOT_EMPTIED",
          "The credential field was refilled when focused, so a planted value was not attributed to the user.",
        );
    }
    const native = await onNode<string>(debuggee, id, setNativeValue, [value]).catch(
      (error: unknown) => {
        // Nothing was written yet: the node is gone (remounted), so the fill may resolve again.
        if (/could not find node|no node with|STALE_REF/i.test(String(error)))
          throw staleBeforeInsert();
        throw error;
      },
    );
    if (native === "done") {
      if (options.vault !== false) await noteVaultFill(debuggee, id).catch(() => undefined);
      return { via: "native-setter" };
    }
    if (native !== "text") throw new Error(native);
    const typed = await fillTextNode(debuggee, id, value);
    if (options.vault !== false) await noteVaultFill(debuggee, id).catch(() => undefined);
    return typed;
  });
}
function setNativeValue(this: HTMLInputElement | HTMLSelectElement, value: string): string {
  if (this instanceof HTMLSelectElement) {
    const options = [...this.options].filter((option) => !option.disabled);
    const normalize = (text: string) => text.trim().toLowerCase();
    let matches = options.filter(
      (option) =>
        normalize(option.value) === normalize(value) || normalize(option.text) === normalize(value),
    );
    if (!matches.length)
      matches = options.filter((option) => normalize(option.text).startsWith(normalize(value)));
    if (matches.length !== 1) return matches.length ? "AMBIGUOUS_TARGET" : "TARGET_NOT_FOUND";
    const match = matches[0];
    if (!match) return "TARGET_NOT_FOUND";
    this.value = match.value;
  } else if (
    this instanceof HTMLInputElement &&
    ["date", "time", "datetime-local", "month", "week", "number", "range", "color"].includes(
      this.type,
    )
  ) {
    const before = this.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(this, value);
    if (this.value !== value) {
      setter?.call(this, before);
      return "INPUT_FAILED";
    }
  } else return "text";
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "done";
}
export async function focusNode(debuggee: chrome.debugger.Debuggee, id: number): Promise<void> {
  const focused = await onNode<boolean>(debuggee, id, function (this: HTMLElement) {
    this.focus({ preventScroll: true });
    return (this.getRootNode() as Document | ShadowRoot).activeElement === this;
  });
  if (!focused) throw new Error("INVALID_TARGET");
}
const keys: Record<string, [string, number, string?]> = {
  Enter: ["Enter", 13, "\r"],
  Tab: ["Tab", 9],
  Escape: ["Escape", 27],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowUp: ["ArrowUp", 38],
  ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36],
  End: ["End", 35],
  Space: ["Space", 32, " "],
};
export async function pressKey(debuggee: chrome.debugger.Debuggee, key: string): Promise<void> {
  const entry = keys[key];
  if (!entry) throw new Error("INVALID_TARGET");
  const [code, windowsVirtualKeyCode, text] = entry;
  const event = { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode };
  showAgentKeys(debuggee, [key]);
  await paceKey(debuggee);
  await send(
    debuggee,
    "Input.dispatchKeyEvent",
    {
      type: text ? "keyDown" : "rawKeyDown",
      ...event,
      ...(text ? { text, unmodifiedText: text } : {}),
    },
    { label: "pressKey" },
  );
  await send(
    debuggee,
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...event },
    { label: "pressKey" },
  );
}

type Step = Extract<BrowserExecutorRequest["step"], { op: "pointer" | "keys" }>;
export async function executeInteraction(
  debuggee: chrome.debugger.Debuggee,
  step: Step,
): Promise<unknown> {
  if (step.op === "keys") return keyboard(debuggee, step.keys);
  return dispatchPointer(debuggee, step);
}
const IS_MAC = /Mac/i.test(globalThis.navigator?.platform ?? "");
const MAC_COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
};
async function keyboard(debuggee: chrome.debugger.Debuggee, combo: string): Promise<unknown> {
  const parts = combo.split("+"),
    key = parts.pop();
  if (!key && combo.length > 1) {
    // "C++": text ending in a plus is typed, not read as a combo.
    await humanType(debuggee, combo, { keys: true });
    return { typed: combo.length };
  }
  if (!key) throw new Error("INVALID_TARGET");
  // Text that only looks like a combo ("C++", "a+b=c") is typed, not pressed.
  if (
    combo.length > 1 &&
    !parts.every((part) => part in KEY_MASKS || part === "ControlOrMeta" || part === "Mod")
  ) {
    await humanType(debuggee, combo, { keys: true });
    return { typed: combo.length };
  }
  let modifiers = 0;
  for (const part of parts) {
    const mask = part === "ControlOrMeta" || part === "Mod" ? (IS_MAC ? 4 : 2) : KEY_MASKS[part];
    if (!mask) throw new Error("Unknown modifier: " + part);
    modifiers |= mask;
  }
  const windowsVirtualKeyCode =
    KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  // Plain text (no modifiers, not a named key) is typed one character at a time.
  if (!parts.length && !(key in KEY_CODES) && key.length > 1) {
    await humanType(debuggee, key, { keys: true });
    return { typed: key.length };
  }
  if (!windowsVirtualKeyCode) throw new Error("Unsupported key");
  // The fill blurred the password: Enter must land in it again or the form never submits and
  // nothing is saved. A focused control is left alone; a locator Enter stays the guard's.
  if (!modifiers && (key === "Enter" || key === "NumpadEnter")) await focusFilledPassword(debuggee);
  const params = { key: key === "Space" ? " " : key, modifiers, windowsVirtualKeyCode };
  // Enter and Space produce text, and Chrome submits a form only when the key event carries it;
  // a keyDown without text left the form unsubmitted (page.keyboard.press('Enter')).
  const text =
    !modifiers && key === "Enter" ? "\r" : !modifiers && key === "Space" ? " " : undefined;
  // macOS runs Cmd shortcuts as editing commands, which synthetic key events do not trigger alone.
  const command = IS_MAC && modifiers === 4 ? MAC_COMMANDS[key.toLowerCase()] : undefined;
  showAgentKeys(debuggee, [combo]);
  await paceKey(debuggee);
  await send(
    debuggee,
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      ...params,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(!modifiers && !text && key.length === 1 ? { text: key } : {}),
      ...(command ? { commands: [command] } : {}),
    },
    { label: "keyboard" },
  );
  await send(
    debuggee,
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...params },
    { label: "keyboard" },
  );
  return { pressed: combo };
}

function elementCaption(
  request: BrowserExecutorRequest,
  node: AxRef,
  editable: boolean,
): Omit<CursorUpdate, "x" | "y" | "press"> {
  const value = (request.step as { value?: unknown }).value;
  if (editable && typeof value === "string")
    return { text: true, typing: true, transient: true, caption: `Typing "${value.slice(0, 60)}"` };
  const label = node.name ? `"${node.name.slice(0, 50)}"` : node.role || "element";
  const verb =
    request.step.op === "click"
      ? "Clicking "
      : request.step.op === "press"
        ? "Pressing on "
        : "Using ";
  return { text: editable, transient: request.step.op === "click", caption: verb + label };
}

// Retry only preparation. A delivered click, key or insertion is never replayed.
export async function prepareElement(
  debuggee: chrome.debugger.Debuggee,
  request: BrowserExecutorRequest,
  element: BrowserElementTarget,
  revalidate: () => Promise<void>,
  editable = false,
  deadline = Date.now() + DEFAULT_STEP_MS,
  force = false,
): Promise<{
  node: AxRef;
  point: Point;
  frame: chrome.debugger.Debuggee;
  top: { x: number; y: number; offsetX: number; offsetY: number };
}> {
  if (!("target" in request.step)) throw new Error("INVALID_TARGET");
  const missing = {
    deadline,
    quietSince: Date.now(),
    seen: undefined as number | undefined,
  };
  let target = element;
  let blocked = 0;
  for (;;) {
    await revalidate();
    try {
      const node = await resolveElement(
        debuggee,
        target,
        request.step.target,
        browserObservationRefs.refs,
        browserObservationRefs.latestSnapshots,
        request.expectedDocumentEpoch,
        request.chatId,
      );
      // A frame's node acts through its own session: DOM ids and Input coordinates are local to it.
      const frame = node.sessionId ? { ...debuggee, sessionId: node.sessionId } : debuggee;
      const point = await actionablePoint(frame, node.backendNodeId, editable, force, deadline);
      // Input events go to the root session in main-viewport coordinates, however deep the frame.
      const top = node.frameId
        ? await rootFramePoint(debuggee, node.frameId, point)
        : { ...point, offsetX: 0, offsetY: 0 };
      showAgentCursor(debuggee, top.x, top.y, false, elementCaption(request, node, editable));
      // A fill came through a checked target moments ago and is about to resolve this node again;
      // a click still re-checks because it may have opened or moved something.
      if (!editable) await revalidate();
      return { node, point, frame, top };
    } catch (caught) {
      const error = normalizePreparationError(caught);
      if (await holdMissingTarget(debuggee, error, missing)) continue;
      // A fill whose ref went stale (a framework remounted the field) resolves again through
      // the ref's recorded role and name, until the step's deadline.
      const relocated = editable ? relocateRef(target, error) : undefined;
      if (relocated && Date.now() + 200 < deadline) {
        target = relocated;
        continue;
      }
      // A cover that stays is answered fast with what covers it; an animating one gets two tries.
      if (error instanceof Error && error.message === "TARGET_BLOCKED" && ++blocked > 2)
        throw error;
      if (
        Date.now() + 200 >= deadline ||
        !(error instanceof Error) ||
        !retryablePreparation(error, target)
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

type ActionRequest = BrowserExecutorRequest & {
  step: Extract<BrowserStep, { op: "click" | "hold" | "fill" | "paste" | "scroll" }>;
  /** One absolute deadline for every retry in this step, set once in performAction. */
  deadline?: number;
};
export async function clickScreenshotPoint(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
): Promise<void> {
  if (request.step.op !== "click" || request.step.element.kind !== "point")
    throw new Error("INVALID_TARGET");
  const point = screenshotPoint(
    request.step.element.screenshotId,
    request.step.target,
    request.expectedDocumentEpoch ?? -1,
  );
  const metrics = (await send(debuggee, "Page.getLayoutMetrics", undefined, {
    label: "clickScreenshotPoint",
  })) as {
    cssVisualViewport?: {
      clientWidth?: number;
      clientHeight?: number;
      pageX?: number;
      pageY?: number;
    };
  };
  const viewport = metrics.cssVisualViewport;
  if (
    viewport?.clientWidth !== point.viewport.width ||
    viewport.clientHeight !== point.viewport.height ||
    Math.abs((viewport.pageX ?? 0) - point.scrollX) > 1 ||
    Math.abs((viewport.pageY ?? 0) - point.scrollY) > 1
  )
    throw new Error("STALE_REF");
  if ((await viewportFingerprint(debuggee)) !== point.fingerprint) throw new Error("STALE_REF");
  await clickAt(
    debuggee,
    Math.round(point.viewport.width * request.step.element.x),
    Math.round(point.viewport.height * request.step.element.y),
    pointerPress(request.step),
  );
}

export async function interactFrame(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  selector: string | number,
  value?: string,
): Promise<unknown> {
  const objectId = await resolveFrameObject(debuggee, frameId, selector);
  try {
    const node = (await send(
      debuggee,
      "DOM.describeNode",
      { objectId },
      {
        label: "interactFrame",
      },
    )) as { node: { backendNodeId: number } };
    if (value !== undefined) {
      await fillNode(debuggee, node.node.backendNodeId, value);
      return { filled: true };
    }
    const point = await onNode<{
      x: number;
      y: number;
      activated?: boolean;
      disabled?: boolean;
      file?: boolean;
    }>(debuggee, node.node.backendNodeId, framePoint);
    if (point.file) throw new Error("FILE_INPUT");
    if (point.disabled) throw new Error("TARGET_DISABLED");
    if (point.activated) return { clicked: true, activated: "dom" };
    // Input is sent to this frame's renderer session; same-process frames need the owner offset.
    const offset = await frameOffset(debuggee, frameId);
    await clickAt(debuggee, point.x + offset.x, point.y + offset.y);
    return { clicked: true };
  } finally {
    await send(debuggee, "Runtime.releaseObject", { objectId }, { label: "interactFrame" }).catch(
      () => undefined,
    );
  }
}
async function frameOffset(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<{ x: number; y: number }> {
  const tree = (await send(debuggee, "Page.getFrameTree", undefined, { label: "frameOffset" })) as {
    frameTree: { frame: { id: string } };
  };
  if (tree.frameTree.frame.id === frameId) return { x: 0, y: 0 };
  const owner = (await send(
    debuggee,
    "DOM.getFrameOwner",
    { frameId },
    {
      label: "frameOffset",
    },
  )) as { backendNodeId: number };
  const box = (await send(
    debuggee,
    "DOM.getBoxModel",
    { backendNodeId: owner.backendNodeId },
    { label: "frameOffset" },
  )) as { model: { content: number[] } };
  return { x: box.model.content[0] ?? 0, y: box.model.content[1] ?? 0 };
}

function caused(receipt: ReturnType<typeof takeReceipt>): boolean {
  return Boolean(
    receipt.dialog ||
    receipt.download ||
    receipt.popups.length ||
    receipt.requests?.length ||
    receipt.open?.length,
  );
}

type RevalidateTarget = (request: BrowserExecutorRequest, tabId: number) => Promise<void>;

export async function performAction(
  request: ActionRequest,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const tabId = request.step.target.tabId;
  const stepMs =
    "timeoutMs" in request.step && typeof request.step.timeoutMs === "number"
      ? request.step.timeoutMs
      : DEFAULT_STEP_MS;
  request.deadline ??= Date.now() + stepMs;
  let outcome: "navigated" | "changed" | "unchanged" | "unknown" = "unknown";
  let beforeUrl: string | undefined;
  let note: string | undefined;
  let changes: number | undefined;
  let readback: string | undefined;
  let via: FillVia | undefined;
  let box: { x: number; y: number; width: number; height: number } | undefined;
  let silent = false;
  let childPoint: { x: number; y: number } | undefined;
  const actionId = beginReceipt(tabId);
  beginAction(tabId);
  let dialogs: AnsweredDialog[] = [];
  try {
    const scroll = await withDebugger(tabId, async (debuggee) => {
      const filled = request.step.op === "fill";
      // A fill's own read-back is its verification; preparing it checks the target again just
      // before the input. Settling a page for a value that was set synchronously only adds wait.
      if (!filled) await revalidateTarget(request, tabId);
      if (request.step.op === "scroll")
        return scrollWithFeedback(debuggee, { ...request, step: request.step });
      const before = filled ? undefined : await primeBrowserSettle(debuggee);
      beforeUrl = before?.url;
      const since = Date.now();
      // The click lands now, not when beginReceipt ran: pre-click validation can outlast the
      // causal window under load. Anchor the receipt here so its request is not dropped.
      noteActionStart(actionId, since);
      // The input went out and opened a dialog: the reply raced the answer. Delivered.
      const dispatched = await deliveredThroughDialog(
        tabId,
        dispatchAction(debuggee, request, revalidateTarget),
        undefined,
      );
      readback = dispatched?.readback;
      via = dispatched?.via;
      box = dispatched?.box;
      const answered = dialogsDuringAction(tabId).length > 0;
      if (!filled) {
        const settled = await settleBrowserPage(debuggee, 800, since, 80);
        outcome = pageOutcome(before, settled.probe);
        // The mutation count the page reported between the two probes: evidence for a DOM change.
        if (before && settled.probe) changes = Math.max(0, settled.probe.changes - before.changes);
        silent =
          request.step.op === "click" && outcome === "unchanged" && !settled.network && !answered;
        if (silent && dispatched?.nodeId)
          childPoint = await childHandlerPoint(dispatched.frame ?? debuggee, dispatched.nodeId);
      }
      return undefined;
    });
    if (scroll) await revalidateTarget(request, tabId);
    const current = await refreshInventoryTab(tabId);
    if (!current) throw new Error("TARGET_LOST");
    const liveTab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!liveTab?.url || !drivablePage(liveTab.url)) throw new Error("TARGET_LOST");
    if (
      (request.expectedDocumentEpoch !== undefined &&
        current.documentEpoch !== request.expectedDocumentEpoch) ||
      (beforeUrl !== undefined && liveTab.url !== beforeUrl)
    )
      outcome = "navigated";
    const observation =
      scroll || (request.step.op !== "scroll" && request.step.observe === false)
        ? undefined
        : await observeSemantic(
            { ...request, expectedDocumentEpoch: current.documentEpoch },
            liveTab,
            revalidateTarget,
          );
    dialogs = dialogsDuringAction(tabId);
    const receipt = await finishReceipt(actionId);
    receipt.navigated ||= String(outcome) === "navigated";
    // A dialog, pop-up or download is something happening, even with no DOM change or request.
    // A click that opened a dialog was delivered: it is never reported missed or sent again.
    const missed = silent && !dialogs.length && !caused(receipt) && request.step.op === "click";
    if (missed && request.step.op === "click")
      note = silentClickNote(request.step.element, childPoint !== undefined);
    const query = "element" in request.step ? elementQuery(request.step.element) : undefined;
    const effect = scroll
      ? scrollEffect(scroll)
      : inputStepEffect(
          request.step.op,
          {
            outcome,
            url: liveTab.url,
            ...(changes !== undefined ? { changes } : {}),
            ...(receipt.requests?.length ? { requests: receipt.requests.length } : {}),
            ...(readback !== undefined ? { readback } : {}),
            ...(receipt.dialog
              ? { dialog: { type: receipt.dialog.type, accepted: receipt.dialog.accepted } }
              : {}),
            ...(receipt.download?.filename
              ? { download: { filename: receipt.download.filename } }
              : {}),
          },
          expectedValue(request.step),
          {
            op: request.step.op,
            ...(query ? { query } : {}),
            ...(missed && childPoint ? { childPoint } : {}),
          },
        );
    return BrowserExecutorResultSchema.parse({
      kind: "action",
      target: current.target,
      documentEpoch: current.documentEpoch,
      url: liveTab.url,
      outcome,
      effect: effect.effect,
      evidence: effect.evidence,
      ...(effect.next ? { next: effect.next } : {}),
      receipt,
      ...(note ? { note } : {}),
      ...(observation ? { observation } : {}),
      ...(scroll ? { scroll } : {}),
      ...(box ? { box } : {}),
      ...(via ? { fill: { via, ...(readback !== undefined ? { value: readback } : {}) } } : {}),
      label: actionLabel(request.step),
      ...(dialogs.length ? { dialogs } : {}),
    });
  } finally {
    endAction(tabId);
    dropReceipt(actionId);
  }
}

function actionLabel(step: BrowserStep): string {
  const element = "element" in step ? step.element : undefined;
  const key = "key" in step ? step.key : undefined;
  const url = "url" in step && typeof step.url === "string" ? step.url : undefined;
  return labelForAction({
    op: step.op,
    ...(element ? { element } : {}),
    ...(typeof key === "string" ? { key } : {}),
    ...(url ? { url } : {}),
  }).slice(0, 200);
}

async function dispatchAction(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
  revalidateTarget: RevalidateTarget,
): Promise<
  | {
      readback?: string;
      via?: FillVia;
      nodeId?: number;
      frame?: chrome.debugger.Debuggee;
      box?: { x: number; y: number; width: number; height: number };
    }
  | undefined
> {
  // An element action revalidates inside prepareElement, just before it resolves the target.
  if (request.step.op === "click" && request.step.element.kind === "point") {
    await clickScreenshotPoint(debuggee, request);
    return undefined;
  }
  if (request.step.op === "scroll" && !request.step.element) {
    await scrollViewport(debuggee, request);
    return undefined;
  }
  if (!request.step.element) return void (await pointHold(debuggee, request.step));
  const element = request.step.element;
  const deadline = request.deadline ?? Date.now() + DEFAULT_STEP_MS;
  const prepare = () =>
    prepareElement(
      debuggee,
      request,
      element,
      () => revalidateTarget(request, request.step.target.tabId),
      request.step.op === "fill",
      deadline,
      request.step.op === "fill" && request.step.force === true,
    );
  const { node, point: box, frame, top } = await prepare();
  if (request.step.op === "click" || request.step.op === "fill" || request.step.op === "paste")
    await refuseForeignLoginForm(frame, node.backendNodeId);
  const measured = await measureBox(frame, node.backendNodeId);
  noteActionTiming(debuggee.tabId, {
    box: measured
      ? { ...measured, x: measured.x + top.offsetX, y: measured.y + top.offsetY }
      : undefined,
    point: { x: top.x, y: top.y },
    tAct: Date.now(),
  });
  // A dialog this input opens counts as asked for, however long finding the element took.
  if (debuggee.tabId !== undefined) noteDialogAct(debuggee.tabId);
  if (request.step.op === "click" || request.step.op === "hold") {
    const press = { debuggee: frame, backendNodeId: node.backendNodeId, ...top };
    const tabId = request.step.target.tabId;
    // The press opened a dialog; its reply came back after the answer. Delivered, never resent.
    const pointer = await deliveredThroughDialog(
      tabId,
      deliverAt(debuggee, request.step, top.x, top.y, !!box.activate, press),
      "delivered" as const,
    );
    if (pointer === "activate") await onNode(frame, node.backendNodeId, activateNode);
    return { nodeId: node.backendNodeId, frame, ...(measured ? { box: measured } : {}) };
  } else if (request.step.op === "fill") {
    const tabId = request.step.target.tabId;
    const value = request.step.value;
    let field = { node, frame };
    let typed: { readback?: string; via: FillVia } | undefined;
    for (;;) {
      try {
        // A dialog froze the page mid-fill; once it is answered the value is read back once.
        typed = await deliveredThroughDialog(
          tabId,
          fillNode(field.frame, field.node.backendNodeId, value, {
            vault: vaultField(field.node.name),
          }),
          undefined,
        );
        break;
      } catch (error) {
        // The field was remounted before any text went in: resolve it again, until the deadline.
        // Never after a partial insert (that would type the value twice).
        if (!isStaleBeforeInsert(error) || Date.now() + 200 >= deadline) throw error;
        const again = await prepare();
        field = { node: again.node, frame: again.frame };
      }
    }
    // The text path read the value back; only the native select path needs a separate label read.
    const readback =
      typed?.readback ?? (await readFieldValue(field.frame, field.node.backendNodeId));
    return {
      ...(readback !== undefined ? { readback } : {}),
      ...(typed ? { via: typed.via } : {}),
      ...(measured ? { box: measured } : {}),
    };
  } else if (request.step.op === "paste") {
    await pasteNode(frame, node.backendNodeId, request.step.text, request.step.html);
    const readback = await readFieldValue(frame, node.backendNodeId);
    return {
      ...(readback !== undefined ? { readback } : {}),
      ...(measured ? { box: measured } : {}),
    };
  } else await scrollAt(debuggee, top.x, top.y, request.step.direction, request.step.amount);
  return measured ? { box: measured } : undefined;
}

async function scrollViewport(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
): Promise<void> {
  if (request.step.op !== "scroll" || request.step.element) throw new Error("INVALID_TARGET");
  const center = await getViewportCenter(debuggee);
  await scrollAt(debuggee, center.x, center.y, request.step.direction, request.step.amount);
}
