import { noteActionTiming } from "./native-browser-action-timing.js";
import { hiddenTargetError } from "./native-browser-reveal.js";
import { showAgentCursor } from "./native-browser-cursor.js";
import {
  BrowserActionError,
  snapshotKey,
  textValue,
  type AxNode,
  type AxRef,
} from "./native-browser-common.js";
import type { BrowserElementTarget, BrowserTargetKey } from "@browserkit/protocol";
import { collectAttributeHits, missMessage, type AttributeHit } from "./attribute-hint.js";
import { labelAxMatches } from "./native-browser-label-ax.js";
import { queryNodes, visibleNodes, scopedBackendIds } from "./native-browser-dom.js";
import { ambiguousError, hiddenError, notFoundError } from "./native-browser-candidates.js";
import { collectFrameAx, discoverFrames, frameContext } from "./native-browser-frames.js";
import { humanMouse } from "./native-browser-human-input.js";
import { send } from "./cdp/send.js";
import { pressConfirmed } from "./native-browser-press-probe.js";
import { withFocusEmulation } from "./native-browser-session.js";
export { withBrowserDebugger as withDebugger } from "./native-browser-session.js";

export async function resolveElement(
  debuggee: chrome.debugger.Debuggee,
  element: BrowserElementTarget | undefined,
  target: BrowserTargetKey,
  refs: Map<string, Map<string, AxRef>>,
  latestSnapshots: Map<string, string>,
  documentEpoch?: number,
  chatId?: string,
): Promise<AxRef> {
  if (!element) throw new Error("INVALID_TARGET");
  if (element.kind === "backend" || element.kind === "ref") {
    const direct = await resolveByNodeId(
      debuggee,
      element,
      target,
      refs,
      latestSnapshots,
      documentEpoch,
      chatId,
    );
    if (direct) return direct;
  }
  // A CSS/label/placeholder target resolves by its own selector; only the chosen node needs an
  // accessibility record. The full tree is for role and ref lookups, not for a fill by selector.
  if (element.kind === "query") return resolveQueryFast(debuggee, element, documentEpoch);
  const nodes = await getAxTree(debuggee);
  if (element.kind === "backend") return resolveBackend(nodes, element, documentEpoch);
  if (element.kind === "ref") {
    if (latestSnapshots.get(snapshotKey(chatId, target)) !== element.snapshotId)
      throw new Error("STALE_REF");
    const prior = refs.get(element.snapshotId)?.get(element.ref);
    if (!prior) throw new Error("STALE_REF");
    if (documentEpoch !== undefined && prior.documentEpoch !== documentEpoch)
      throw new Error("STALE_REF");
    // A frame's node lives in that frame's session; its backend id means nothing on the tab's
    // own target, so revalidate it where it was read.
    if (prior.sessionId) {
      const tree = (await send(
        { ...debuggee, sessionId: prior.sessionId },
        "Accessibility.getFullAXTree",
        undefined,
        { label: "resolveElement" },
      ).catch(() => {
        throw new Error("STALE_REF");
      })) as { nodes?: AxNode[] };
      const live = tree.nodes?.find((node) => node.backendDOMNodeId === prior.backendNodeId);
      if (!sameSemanticNode(live, prior)) throw new Error("STALE_REF");
      return prior;
    }
    const live = nodes.find((node) => node.backendDOMNodeId === prior.backendNodeId);
    if (!sameSemanticNode(live, prior)) throw new Error("STALE_REF");
    return prior;
  }
  if (element.kind === "point") throw new Error("STALE_REF");
  return resolveRole(debuggee, nodes, element);
}
async function resolveByNodeId(
  debuggee: chrome.debugger.Debuggee,
  element: BrowserElementTarget,
  target: BrowserTargetKey,
  refs: Map<string, Map<string, AxRef>>,
  latestSnapshots: Map<string, string>,
  documentEpoch?: number,
  chatId?: string,
): Promise<AxRef | undefined> {
  if (element.kind === "backend") return describeBackend(debuggee, element, documentEpoch);
  if (element.kind === "ref")
    return describeRef(debuggee, element, target, refs, latestSnapshots, documentEpoch, chatId);
  return undefined;
}

async function describeBackend(
  debuggee: chrome.debugger.Debuggee,
  element: Extract<BrowserElementTarget, { kind: "backend" }>,
  documentEpoch?: number,
): Promise<AxRef | undefined> {
  if (documentEpoch !== undefined && documentEpoch !== element.documentEpoch)
    throw new Error("STALE_REF");
  // The observation that printed this id already carried the node's words; use them instead of
  // asking the accessibility tree again. A backend id that no longer exists fails on the first
  // DOM call (scroll, resolve or the input itself), so a stale name cannot act on another node.
  if (element.role)
    return {
      backendNodeId: element.backendNodeId,
      documentEpoch: element.documentEpoch,
      role: element.role,
      name: element.name ?? "",
    };
  // One node's accessibility record, not the whole tree: callers label receipts and compare
  // the live role and name, so an empty one is a miss, not a sparse reference.
  const partial = (await send(
    debuggee,
    "Accessibility.getPartialAXTree",
    { backendNodeId: element.backendNodeId, fetchRelatives: false },
    { label: "resolveElement" },
  ).catch(() => undefined)) as { nodes?: AxNode[] } | undefined;
  const node = partial?.nodes?.[0];
  if (!node) return undefined;
  return {
    backendNodeId: element.backendNodeId,
    documentEpoch: element.documentEpoch,
    role: textValue(node.role?.value),
    name: textValue(node.name?.value),
  };
}

async function describeRef(
  debuggee: chrome.debugger.Debuggee,
  element: Extract<BrowserElementTarget, { kind: "ref" }>,
  target: BrowserTargetKey,
  refs: Map<string, Map<string, AxRef>>,
  latestSnapshots: Map<string, string>,
  documentEpoch?: number,
  chatId?: string,
): Promise<AxRef | undefined> {
  if (latestSnapshots.get(snapshotKey(chatId, target)) !== element.snapshotId)
    throw new Error("STALE_REF");
  const prior = refs.get(element.snapshotId)?.get(element.ref);
  if (!prior) throw new Error("STALE_REF");
  if (documentEpoch !== undefined && prior.documentEpoch !== documentEpoch)
    throw new Error("STALE_REF");
  const where = prior.sessionId ? { ...debuggee, sessionId: prior.sessionId } : debuggee;
  if (!(await nodeExists(where, prior.backendNodeId))) return undefined;
  return prior;
}

async function nodeExists(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<boolean> {
  const described = (await send(
    debuggee,
    "DOM.describeNode",
    { backendNodeId },
    { label: "resolveElement" },
  ).catch(() => undefined)) as { node?: unknown } | undefined;
  return Boolean(described?.node);
}

function resolveBackend(
  nodes: AxNode[],
  element: Extract<BrowserElementTarget, { kind: "backend" }>,
  documentEpoch?: number,
): AxRef {
  if (documentEpoch !== element.documentEpoch) throw new Error("STALE_REF");
  // A hidden or accessibility-ignored node often has an empty box. It is still the node
  // the caller named: return it so the click hits it, instead of treating the id as a miss.
  const live = nodes.find((node) => node.backendDOMNodeId === element.backendNodeId);
  if (!live) throw new Error("STALE_REF");
  return {
    backendNodeId: element.backendNodeId,
    documentEpoch: element.documentEpoch,
    role: textValue(live.role?.value),
    name: textValue(live.name?.value),
  };
}

async function resolveRole(
  debuggee: chrome.debugger.Debuggee,
  nodes: AxNode[],
  element: Extract<BrowserElementTarget, { kind: "locator" }>,
): Promise<AxRef> {
  const scoped = element.scope ? await scopedBackendIds(debuggee, element.scope) : undefined;
  const eligible = scoped ? nodes.filter((node) => scoped.has(node.backendDOMNodeId ?? -1)) : nodes;
  const matches = locatorMatches(eligible, element.role, element.name, element.exact);
  if (!matches.length) throw notFoundError(eligible, element.role, element.name);
  const visible = await visibleNodes(
    debuggee,
    matches.map((node) => node.backendDOMNodeId ?? -1),
  );
  const shown = matches.filter((node) => visible.includes(node.backendDOMNodeId ?? -1));
  if (!shown.length)
    throw hiddenError(
      eligible,
      matches[0],
      `the ${element.role} named ${JSON.stringify(element.name)} is not visible`,
      { role: element.role, name: element.name },
    );
  return uniqueNode(shown, "TARGET_HIDDEN", { role: element.role, name: element.name }, eligible);
}

function sameSemanticNode(live: AxNode | undefined, prior: AxRef | undefined): boolean {
  return Boolean(
    prior &&
    live &&
    textValue(live.role?.value) === prior.role &&
    textValue(live.name?.value).slice(0, 512) === prior.name,
  );
}

function locatorMatches(nodes: AxNode[], role: string, name: string, exact = true): AxNode[] {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return nodes.filter(
    (node) =>
      !node.ignored &&
      node.backendDOMNodeId !== undefined &&
      textValue(node.role?.value).toLowerCase() === role.toLowerCase() &&
      (exact
        ? normalize(textValue(node.name?.value)) === normalize(name)
        : normalize(textValue(node.name?.value))
            .toLowerCase()
            .includes(normalize(name).toLowerCase())),
  );
}
function uniqueNode(
  nodes: AxNode[],
  missing: string,
  label: { role: string; name: string },
  tree: AxNode[],
): AxRef {
  if (nodes.length > 1) throw ambiguousError(tree, nodes, label);
  const node = nodes[0];
  if (!node || node.backendDOMNodeId === undefined) throw new Error(missing);
  return {
    backendNodeId: node.backendDOMNodeId,
    role: textValue(node.role?.value),
    name: textValue(node.name?.value),
    ...(node.sessionId ? { sessionId: node.sessionId } : {}),
    ...(node.frameId ? { frameId: node.frameId } : {}),
  };
}
async function resolveQueryFast(
  debuggee: chrome.debugger.Debuggee,
  query: Extract<BrowserElementTarget, { kind: "query" }>,
  documentEpoch?: number,
): Promise<AxRef> {
  const ids = await queryNodes(debuggee, query);
  const visible = await visibleNodes(debuggee, ids);
  if (visible.length > 1) throw ambiguousQuery([], visible, query.value);
  const id = visible[0];
  if (id !== undefined) {
    const ref = await describeBackend(
      debuggee,
      { kind: "backend", backendNodeId: id, documentEpoch: documentEpoch ?? 0 },
      documentEpoch,
    );
    if (!ref) throw new Error("STALE_REF");
    return ref;
  }
  const frames = await discoverFrames(debuggee).catch(() => []);
  const hits: {
    id: number;
    frameId: string;
    sessionId?: string;
    target: chrome.debugger.Debuggee;
  }[] = [];
  let hiddenInFrame: { id: number; target: chrome.debugger.Debuggee } | undefined;
  for (const frame of frames) {
    if (!frame.parentFrameId && !frame.sessionId) continue;
    const frameTarget = frame.sessionId ? { ...debuggee, sessionId: frame.sessionId } : debuggee;
    const contextId = await frameContext(frameTarget, frame.frameId).catch(() => undefined);
    if (contextId === undefined) continue;
    const frameIds = await queryNodes(frameTarget, query, contextId).catch(() => []);
    if (!frameIds.length) continue;
    const frameVisible = await visibleNodes(frameTarget, frameIds).catch(() => []);
    for (const matchId of frameVisible) {
      hits.push({
        id: matchId,
        frameId: frame.frameId,
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        target: frameTarget,
      });
    }
    if (!frameVisible.length && !hiddenInFrame && frameIds[0] !== undefined)
      hiddenInFrame = { id: frameIds[0], target: frameTarget };
  }
  if (hits.length > 1)
    throw ambiguousQuery(
      [],
      hits.map((h) => h.id),
      query.value,
    );
  const hit = hits[0];
  if (hit) {
    const ref = await describeBackend(
      hit.target,
      { kind: "backend", backendNodeId: hit.id, documentEpoch: documentEpoch ?? 0 },
      documentEpoch,
    );
    if (!ref) throw new Error("STALE_REF");
    return {
      ...ref,
      frameId: hit.frameId,
      ...(hit.sessionId ? { sessionId: hit.sessionId } : {}),
    };
  }
  if (ids[0] !== undefined) throw await hiddenQuery(debuggee, [], ids[0], query.value);
  if (query.by === "label" && !hiddenInFrame) {
    // A closed shadow root hides the control from the DOM walk, not from the accessibility tree.
    const tree = await getAxTree(debuggee).catch(() => []);
    const named = labelAxMatches(tree, query.value, query.exact !== false);
    if (named.length) return uniqueNode(named, "STALE_REF", { role: "", name: query.value }, tree);
  }
  if (hiddenInFrame)
    throw await hiddenQuery(hiddenInFrame.target, [], hiddenInFrame.id, query.value);
  throw await missedQuery(debuggee, query);
}

async function missedQuery(
  debuggee: chrome.debugger.Debuggee,
  query: Extract<BrowserElementTarget, { kind: "query" }>,
): Promise<BrowserActionError> {
  const hits = await send<{ result?: { value?: unknown } }>(
    debuggee,
    "Runtime.evaluate",
    {
      expression: `(${collectAttributeHits.toString()})()`,
      returnByValue: true,
    },
    { label: "attributeHint", ms: 5_000 },
  )
    .then((result) => attributeHits(result.result?.value))
    .catch(() => []);
  return new BrowserActionError("TARGET_NOT_FOUND", missMessage(query, hits), {
    target: { name: query.value },
  });
}

function attributeHits(value: unknown): AttributeHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const hit = item as AttributeHit;
    if (typeof hit.tag !== "string") return [];
    return [
      {
        tag: hit.tag,
        role: typeof hit.role === "string" ? hit.role : "",
        placeholder: typeof hit.placeholder === "string" ? hit.placeholder : "",
        label: typeof hit.label === "string" ? hit.label : "",
        text: typeof hit.text === "string" ? hit.text : "",
      },
    ];
  });
}

function ambiguousQuery(nodes: AxNode[], ids: number[], value: string): Error {
  const matches = nodes.filter((node) => ids.includes(node.backendDOMNodeId ?? -1));
  const listed = matches.length
    ? matches
    : ids.map((id) => ({ backendDOMNodeId: id, role: { value: "element" }, name: { value } }));
  return ambiguousError(nodes, listed, { role: "element", name: value, selector: value });
}

async function hiddenQuery(
  debuggee: chrome.debugger.Debuggee,
  nodes: AxNode[],
  id: number,
  value: string,
): Promise<Error> {
  const hinted = await hiddenTargetError(debuggee, id);
  const detail =
    hinted instanceof BrowserActionError ? hinted.detail : "the element is not visible";
  const hidden = nodes.find((node) => node.backendDOMNodeId === id);
  return hiddenError(nodes, hidden, detail, { role: "", name: value, selector: value });
}

export async function getAxTree(debuggee: chrome.debugger.Debuggee): Promise<AxNode[]> {
  const result = (await send(debuggee, "Accessibility.getFullAXTree", undefined, {
    label: "getAxTree",
  })) as {
    nodes?: AxNode[];
  };
  if (!Array.isArray(result.nodes)) throw new Error("UNSUPPORTED");
  const frames = (await send(debuggee, "Page.getFrameTree", undefined, {
    label: "getAxTree",
  }).catch(() => undefined)) as { frameTree?: { frame?: { id?: string } } } | undefined;
  const rootFrameId = frames?.frameTree?.frame?.id;
  if (!rootFrameId) return result.nodes;
  return collectFrameAx(debuggee, rootFrameId, result.nodes);
}

export async function getViewportCenter(
  debuggee: chrome.debugger.Debuggee,
): Promise<{ x: number; y: number }> {
  const viewport = await getViewportSize(debuggee);
  return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
}

export async function getViewportSize(
  debuggee: chrome.debugger.Debuggee,
): Promise<{ width: number; height: number }> {
  const result = (await send(debuggee, "Page.getLayoutMetrics", undefined, {
    label: "getViewportSize",
  })) as {
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const width = Math.floor(result.cssVisualViewport?.clientWidth ?? 0);
  const height = Math.floor(result.cssVisualViewport?.clientHeight ?? 0);
  if (width < 1 || height < 1) throw new Error("UNSUPPORTED");
  return { width, height };
}

export async function getCenter(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  await send(debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, { label: "getCenter" });
  const result = (await send(
    debuggee,
    "DOM.getBoxModel",
    { backendNodeId },
    {
      label: "getCenter",
    },
  )) as { model?: { content?: number[] } };
  const quad = result.model?.content;
  if (!quad || quad.length < 8) throw new Error("STALE_REF");
  const x = [quad[0], quad[2], quad[4], quad[6]];
  const y = [quad[1], quad[3], quad[5], quad[7]];
  if (
    x.some((coordinate) => coordinate === undefined) ||
    y.some((coordinate) => coordinate === undefined)
  )
    throw new Error("STALE_REF");
  return {
    x: centerOf(x),
    y: centerOf(y),
  };
}

function centerOf(coordinates: (number | undefined)[]): number {
  const total = coordinates.reduce<number>((sum, coordinate) => sum + (coordinate ?? 0), 0);
  return Math.round(total / coordinates.length);
}

export const pointerButtonBits = { left: 1, right: 2, middle: 4, back: 8, forward: 16 } as const;
const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, meta: 4, shift: 8 };

export interface PointerPress {
  button?: keyof typeof pointerButtonBits;
  modifiers?: number;
}

/** The CDP button and modifier mask for a click step. Omitted fields stay a plain left click. */
export function pointerPress(step: {
  button?: string | undefined;
  modifiers?: readonly string[] | undefined;
}): PointerPress {
  const button =
    step.button && step.button in pointerButtonBits
      ? (step.button as PointerPress["button"])
      : undefined;
  const modifiers = (step.modifiers ?? []).reduce(
    (mask, name) => mask | (MODIFIER_BITS[name] ?? 0),
    0,
  );
  return { ...(button ? { button } : {}), ...(modifiers ? { modifiers } : {}) };
}

/**
 * The element a press is meant to land on. `debuggee` is the frame session whose DOM ids match
 * `backendNodeId`; `offsetX`/`offsetY` translate a main-viewport landing point back to that frame.
 * Input still goes out on the root session, so a layout shift or a transient overlay between
 * measurement and press can hit something else and lose the mousedown entirely (the release then
 * lands on the control, giving a mouseup with no mousedown and no click). No press is sent until
 * the intended element is confirmed under the point; a persistent mismatch is reported instead.
 */
export interface PressTarget {
  debuggee: chrome.debugger.Debuggee;
  backendNodeId: number;
  offsetX: number;
  offsetY: number;
}

export async function clickAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  spec?: PointerPress,
  target?: PressTarget,
): Promise<void> {
  showAgentCursor(debuggee, x, y, true);
  noteActionTiming(debuggee.tabId, { tAct: Date.now(), point: { x, y } });
  await withFocusEmulation(debuggee.tabId, () => pressAt(debuggee, x, y, spec, target));
}

function mouseBits(spec: PointerPress | undefined, phase: "move" | "down" | "up") {
  const button = spec?.button ?? "left";
  const modifiers = spec?.modifiers ?? 0;
  return {
    ...(phase === "move"
      ? {}
      : { button, buttons: phase === "down" ? pointerButtonBits[button] : 0 }),
    ...(modifiers ? { modifiers } : {}),
  };
}

async function pressAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  spec?: PointerPress,
  target?: PressTarget,
): Promise<void> {
  const at = await land(debuggee, x, y, "clickAt", spec?.modifiers ?? 0);
  await verifyPressTarget(debuggee, at, target, false);
  await send(
    debuggee,
    "Input.dispatchMouseEvent",
    { type: "mousePressed", ...at, ...mouseBits(spec, "down"), clickCount: 1 },
    { label: "clickAt" },
  );
  await send(
    debuggee,
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", ...at, ...mouseBits(spec, "up"), clickCount: 1 },
    { label: "clickAt" },
  );
}

/** Press-and-hold length. Omitted or non-finite uses the default; the cap is 15s. */
export const HOLD_DEFAULT_MS = 1500;
export const HOLD_MAX_MS = 15000;

export function clampHoldMs(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return HOLD_DEFAULT_MS;
  return Math.min(HOLD_MAX_MS, Math.max(0, Math.round(ms)));
}

/** Same landing as a click, then the left button stays down for `ms` before it releases. */
export async function holdAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  ms?: number,
  target?: PressTarget,
): Promise<void> {
  showAgentCursor(debuggee, x, y, true);
  noteActionTiming(debuggee.tabId, { tAct: Date.now(), point: { x, y } });
  await withFocusEmulation(debuggee.tabId, () =>
    holdPressed(debuggee, x, y, clampHoldMs(ms), target),
  );
}

/** A coordinate hold. Anything else (a click with no element, one axis) is not a target. */
export async function pointHold(
  debuggee: chrome.debugger.Debuggee,
  step: { op: string; x?: number | undefined; y?: number | undefined; ms?: number | undefined },
): Promise<void> {
  if (step.op !== "hold" || step.x === undefined || step.y === undefined)
    throw new Error("INVALID_TARGET");
  await holdAt(debuggee, step.x, step.y, step.ms);
}

/** Click or hold at a point. A click whose box asks for DOM activation is left to the caller. */
export async function deliverAt(
  debuggee: chrome.debugger.Debuggee,
  step: {
    op: string;
    ms?: number | undefined;
    button?: string | undefined;
    modifiers?: readonly string[] | undefined;
  },
  x: number,
  y: number,
  activate: boolean,
  target?: PressTarget,
): Promise<"activate" | "sent"> {
  const spec = pointerPress(step);
  const plain = !spec.button && !spec.modifiers;
  // A DOM activate is a plain left click. Another button or a held modifier has to be a real press.
  if (step.op === "click" && activate && plain) return "activate";
  if (step.op === "hold") await holdAt(debuggee, x, y, step.ms, target);
  else await clickAt(debuggee, x, y, spec, target);
  return "sent";
}

async function land(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  label: string,
  modifiers = 0,
): Promise<{ x: number; y: number }> {
  const held = modifiers ? { modifiers } : {};
  // One direct move, unless the recorder's pointer is on: then the curve plays and this is the landing.
  const moved = await humanMouse(debuggee, "mouseMoved", { x, y, ...held });
  const at = {
    x: typeof moved.x === "number" ? moved.x : x,
    y: typeof moved.y === "number" ? moved.y : y,
  };
  await send(
    debuggee,
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...at, ...held },
    { label },
  );
  return at;
}

// A freshly opened or hydrating page can put a different element under the press point for a few
// frames, even after the target's box was measured. Re-land and re-check for a short window before
// giving up; a 120 ms beat is enough for a transient overlay to clear and for layout to settle.
const PRESS_SETTLE_TRIES = 8;
const PRESS_SETTLE_MS = 120;

// Compare with the page's own hit test rather than a CDP backend id: piercing open shadow roots
// via shadowRoot.elementFromPoint works inside a frame's own session, crosses shadow boundaries,
// and ignores pointer-events:none elements (so Graft's cursor overlay is never mistaken for a hit).
const PRESS_HIT_FUNCTION = `function (x, y) {
  var el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === "function") {
    var deeper = el.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === el) break;
    el = deeper;
  }
  if (!el) return false;
  var parentOf = function (node) {
    return node.parentElement || node.parentNode || node.host || null;
  };
  for (var n = el; n; n = parentOf(n)) if (n === this) return true;
  // A transparent child over its ancestor: the ancestor is still the intended control.
  var r = this.getBoundingClientRect && this.getBoundingClientRect();
  if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
    for (var m = this; m; m = parentOf(m)) if (m === el) return true;
  }
  return false;
}`;

/** True when the page's own hit test at `x,y` lands on the intended element `target`. */
async function underPressPoint(target: PressTarget, x: number, y: number): Promise<boolean> {
  const node = await send<{ object?: { objectId?: string } }>(
    target.debuggee,
    "DOM.resolveNode",
    { backendNodeId: target.backendNodeId },
    { label: "pressTarget" },
  ).catch(() => undefined);
  const objectId = node?.object?.objectId;
  if (!objectId) return true; // Cannot verify: let the press through rather than break a working page.
  const answer = await send<{ result?: { value?: boolean } }>(
    target.debuggee,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: PRESS_HIT_FUNCTION,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    },
    { label: "pressTarget", ms: 2_000 },
  ).catch(() => undefined);
  if (answer?.result?.value === undefined) return true; // Same: an unreadable hit is not proof of loss.
  return answer.result.value === true;
}

/**
 * Confirm the intended element is under the landing point before any press goes out. A hold
 * reports a target that never arrives; a click only settles and re-lands (clicks have their own
 * readback, and a strict check there would reject legitimate ancestor/shadow hits).
 */
async function verifyPressTarget(
  debuggee: chrome.debugger.Debuggee,
  at: { x: number; y: number },
  target: PressTarget | undefined,
  required: boolean,
): Promise<void> {
  if (!target) return;
  const x = at.x - target.offsetX;
  const y = at.y - target.offsetY;
  for (let attempt = 0; attempt < PRESS_SETTLE_TRIES; attempt++) {
    if (await underPressPoint(target, x, y)) return;
    if (attempt + 1 < PRESS_SETTLE_TRIES) {
      await sleep(PRESS_SETTLE_MS);
      // Re-land the pointer at the same main-viewport point; the page may have shifted under it.
      await send(
        debuggee,
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", ...at },
        { label: "pressTarget" },
      ).catch(() => undefined);
    }
  }
  // Reporting beats pressing blind: a press onto the wrong element gives a release with no
  // matching mousedown and no click, which a caller cannot distinguish from a no-op.
  if (required)
    throw new Error("TARGET_LOST: the target is not under the press point; no press was sent");
}

const HOLD_JITTER_MIN_MS = 140;
const HOLD_JITTER_SPAN_MS = 120;

function holdShift(): number {
  return Math.round((Math.random() * 2 - 1) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntil(started: number, ms: number): Promise<void> {
  for (;;) {
    const left = ms - (Date.now() - started);
    if (left <= 0) return;
    await sleep(left);
  }
}

async function holdPressed(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  ms: number,
  target?: PressTarget,
): Promise<void> {
  const at = await land(debuggee, x, y, "holdAt");
  await verifyPressTarget(debuggee, at, target, true);
  await pressConfirmed(debuggee, at, target);
  // The page times its dwell from the mousedown it receives, so the clock starts when the press
  // has landed. Counting from before the send made a slow renderer shorten the hold (a 1.2s hold
  // against a 1s control released before the page had seen a second pass).
  const pressedAt = Date.now();
  let next = pressedAt + HOLD_JITTER_MIN_MS + Math.floor(Math.random() * HOLD_JITTER_SPAN_MS);
  while (Date.now() - pressedAt < ms) {
    const left = ms - (Date.now() - pressedAt);
    const untilJitter = next - Date.now();
    if (untilJitter >= left) break;
    await sleep(Math.max(0, untilJitter));
    if (Date.now() - pressedAt >= ms) break;
    // About a pixel, so the pointer stays on the control. Release goes back to the press point.
    await send(
      debuggee,
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: Math.round((at.x + holdShift()) * 10) / 10,
        y: Math.round((at.y + holdShift()) * 10) / 10,
        button: "left",
        buttons: 1,
      },
      { label: "holdAt" },
    );
    next = Date.now() + HOLD_JITTER_MIN_MS + Math.floor(Math.random() * HOLD_JITTER_SPAN_MS);
  }
  await sleepUntil(pressedAt, ms);
  await send(
    debuggee,
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", ...at, button: "left", clickCount: 1, buttons: 0 },
    { label: "holdAt" },
  );
}

export async function scrollAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount: number,
): Promise<void> {
  const positive = direction === "down" || direction === "right" ? 1 : -1;
  const params = await humanMouse(debuggee, "mouseWheel", {
    type: "mouseWheel",
    x,
    y,
    deltaX: direction === "left" || direction === "right" ? amount * positive : 0,
    deltaY: direction === "up" || direction === "down" ? amount * positive : 0,
  });
  await withFocusEmulation(debuggee.tabId, () =>
    send(
      debuggee,
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", ...params },
      { label: "scrollAt" },
    ),
  );
}
