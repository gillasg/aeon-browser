import { send } from "./cdp/send.js";

// A press sent to a renderer that has not produced a frame since the page loaded, or that is busy
// committing one, can be dropped: CDP acknowledges the mousePressed, the page never sees a
// mousedown, and a hold then releases onto nothing ("hold unchanged" after the full dwell). The
// probe arms a capture listener on the target's window, waits one frame so the page is painting,
// and afterwards reads whether a left mousedown reached the target. A press it did not see is
// released and sent again; the dwell is timed from the press the page actually received.

const ARM = `function (key) {
  var el = this, view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  var rec = { seen: false };
  var on = function (e) {
    if (e.button !== 0) return;
    var path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
    if (path.indexOf(el) >= 0) rec.seen = true;
  };
  view.addEventListener("mousedown", on, true);
  Object.defineProperty(el, key, {
    configurable: true,
    value: { rec: rec, off: function () { view.removeEventListener("mousedown", on, true); } },
  });
  return new Promise(function (done) {
    var fallback = setTimeout(function () { done(true); }, 250);
    view.requestAnimationFrame(function () { clearTimeout(fallback); done(true); });
  });
}`;

const READ = `function (key, keep) {
  var probe = this[key];
  if (!probe) return null;
  var seen = probe.rec.seen;
  if (!keep || seen) { probe.off(); delete this[key]; }
  return seen;
}`;

export interface PressProbe {
  /** True when the page saw the press, false when it did not, undefined when unreadable. */
  seen(final: boolean): Promise<boolean | undefined>;
}

const PROBE_READS = 6;
const PROBE_READ_MS = 50;

export async function armPressProbe(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<PressProbe | undefined> {
  const node = await send<{ object?: { objectId?: string } }>(
    debuggee,
    "DOM.resolveNode",
    { backendNodeId },
    { label: "pressProbe" },
  ).catch(() => undefined);
  const objectId = node?.object?.objectId;
  if (!objectId) return undefined;
  const key = `__p${Math.random().toString(36).slice(2)}`;
  const armed = await send<{ result?: { value?: unknown } }>(
    debuggee,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: ARM,
      arguments: [{ value: key }],
      awaitPromise: true,
      returnByValue: true,
    },
    { label: "pressProbe", ms: 2_000 },
  ).catch(() => undefined);
  if (armed?.result?.value !== true) return undefined;
  const read = async (keep: boolean) => {
    const answer = await send<{ result?: { value?: unknown } }>(
      debuggee,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: READ,
        arguments: [{ value: key }, { value: keep }],
        returnByValue: true,
      },
      { label: "pressProbe", ms: 2_000 },
    ).catch(() => undefined);
    const value = answer?.result?.value;
    return typeof value === "boolean" ? value : undefined;
  };
  return {
    async seen(final) {
      // The mousedown can trail the CDP ack by a frame or two; give it a short window.
      for (let attempt = 0; attempt < PROBE_READS; attempt++) {
        const last = attempt + 1 === PROBE_READS;
        const value = await read(!(final && last));
        if (value !== false || last) return value;
        await new Promise((done) => setTimeout(done, PROBE_READ_MS));
      }
      return undefined;
    },
  };
}

const HOLD_PRESS_TRIES = 3;
const OFF_PAGE = { x: -1, y: -1 };

/**
 * Send the hold's mousePressed and, when the target is known, confirm the page received it. A
 * renderer that drops the press (no frame yet, a frame mid-commit) would otherwise get a release
 * with no mousedown after the whole dwell: the hold reads as "unchanged". A missed press is
 * released and sent again; one the page never sees is reported instead of held blind.
 */
export async function pressConfirmed(
  debuggee: chrome.debugger.Debuggee,
  at: { x: number; y: number },
  target: { debuggee: chrome.debugger.Debuggee; backendNodeId: number } | undefined,
): Promise<void> {
  const probe = target ? await armPressProbe(target.debuggee, target.backendNodeId) : undefined;
  const press = (type: "mousePressed" | "mouseReleased", point = at) =>
    send(
      debuggee,
      "Input.dispatchMouseEvent",
      { type, ...point, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 },
      { label: "holdAt" },
    );
  for (let attempt = 1; ; attempt++) {
    await press("mousePressed");
    const last = attempt >= HOLD_PRESS_TRIES;
    if (!probe || (await probe.seen(last)) !== false) return;
    // The browser counts the button as down; release it before the next press. The page never
    // saw that mousedown, so the release goes off the page: released on the target, it reached
    // the control as a stray mouseup (one press, two releases) once the renderer caught up.
    await press("mouseReleased", OFF_PAGE);
    if (last)
      throw new Error("TARGET_LOST: the page never received the press; the hold was not held");
  }
}
