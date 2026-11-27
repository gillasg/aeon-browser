// What an input step's result says it caused: a closed effect, with the evidence it rests on.
// The point is that "the click was delivered" and "the click did something" stop being mixed:
// confirmed needs readable evidence (a value read back, a navigation, a DOM change), a step that
// ran without evidence is unverifiable, and a bounded unchanged state is a suspected no-op rather
// than a failure. Cua Driver's ActionResult.effect, adapted to what Graft can see in one step.
import {
  effectNext,
  INPUT_MAY_HAVE_LANDED_NOTE,
  type BrowserElementTarget,
  type BrowserStep,
  type EffectNextContext,
} from "@browserkit/protocol";

export type StepEffect = "confirmed" | "opened_tab" | "unverifiable" | "suspected_noop" | "refused";

export interface EffectVerdict {
  effect: StepEffect;
  evidence: string;
  /** The call to run when the effect was not confirmed. */
  next?: string;
  /** The tab the step opened, for opened_tab. */
  tab?: { id: number; url: string };
}

export type StepOutcome = "navigated" | "changed" | "unchanged" | "unknown";

/** Everything one input step learned after it ran. */
export interface StepObservation {
  outcome: StepOutcome;
  /** URL after the step, for a navigation's evidence. */
  url?: string;
  /** DOM mutations the page reported after the step. */
  changes?: number;
  /** fetch/XHR calls the step caused. */
  requests?: number;
  /** The field's value read back after a fill or paste. */
  readback?: string;
  /** A JavaScript dialog this step raised. */
  dialog?: { type: string; accepted: boolean };
  /** A download this step started. */
  download?: { filename: string };
  /** Tabs this tab opened during the step (a target=_blank link, window.open). */
  popups?: { tabId: number; url: string }[];
}

const MAX_EVIDENCE = 200;

const shorten = (text: string) =>
  text.length > MAX_EVIDENCE ? text.slice(0, MAX_EVIDENCE - 3) + "..." : text;

/** The effect of a step that did not run: it was refused, and the code is the evidence. */
export function refusedEffect(code: string): EffectVerdict {
  return { effect: "refused", evidence: shorten(code || "refused") };
}

/**
 * A write action that was sent and then failed or timed out. Its effect is unknown, not refused:
 * the text or click may have landed, so the verdict carries no next-step hint to repeat it.
 */
export function sentActionEffect(code: string): EffectVerdict {
  return {
    effect: "unverifiable",
    evidence: shorten(`${code || "action failed"}; ${INPUT_MAY_HAVE_LANDED_NOTE}`),
  };
}

const SENT_THEN_FAILED =
  /^(TIMEOUT|CHROME_ERROR|TAB_UNRESPONSIVE|TAB_DEAD|NETWORK|SITE_BROKEN|RATE_LIMITED|INTERNAL|INPUT_FAILED|EXPECTATION_FAILED|DEBUGGER_DETACHED|TARGET_LOST|ABILITY_TIMEOUT|INPUT_MAY_HAVE_LANDED)\b/;

/** Whether a failed input step might already have reached the page. */
export function mayHaveLanded(code: string): boolean {
  return SENT_THEN_FAILED.test(code || "");
}

/**
 * The effect of a click, fill or paste, from what the page showed. A fill with its value read
 * back is confirmed even when nothing else changed (typing into a field is its own evidence).
 */
export function inputStepEffect(
  op: string,
  observation: StepObservation,
  expected?: string,
  ctx?: EffectNextContext,
): EffectVerdict {
  return attachNext(inputVerdict(op, observation, expected), { ...ctx, op });
}

/** An accepted dialog or a download is evidence, so the step is not a suspected no-op. */
function activityEffect(observation: StepObservation): EffectVerdict | undefined {
  const parts: string[] = [];
  if (observation.dialog?.accepted)
    parts.push(`${observation.dialog.type || "dialog"} dialog accepted`);
  if (observation.download?.filename) parts.push(`download ${observation.download.filename}`);
  if (!parts.length) return undefined;
  return { effect: "confirmed", evidence: shorten(parts.join("; ")) };
}

function attachNext(verdict: EffectVerdict, ctx: EffectNextContext): EffectVerdict {
  const next = effectNext(verdict.effect, ctx);
  return next ? { ...verdict, next } : verdict;
}

function inputVerdict(op: string, observation: StepObservation, expected?: string): EffectVerdict {
  if (op === "fill" || op === "paste") {
    if (observation.readback !== undefined)
      return observation.readback === (expected ?? observation.readback)
        ? {
            effect: "confirmed",
            evidence: shorten(`value read back: ${quote(observation.readback)}`),
          }
        : {
            effect: "unverifiable",
            evidence: shorten(`value read back differs: ${quote(observation.readback)}`),
          };
  }
  // A new tab whose opener is this tab: the click did something, somewhere else. Clicking again
  // would open a second tab (or place a second order).
  const opened = observation.popups?.[0];
  if (opened && op !== "fill" && op !== "paste")
    return {
      effect: "opened_tab",
      evidence: shorten(`opened tab ${opened.tabId}${opened.url ? ` (${opened.url})` : ""}`),
      tab: { id: opened.tabId, url: opened.url },
    };
  if (observation.outcome === "navigated")
    return {
      effect: "confirmed",
      evidence: shorten(`navigation${observation.url ? ` to ${observation.url}` : ""}`),
    };
  if (observation.outcome === "changed")
    return {
      effect: "confirmed",
      evidence: shorten(
        `${observation.changes && observation.changes > 0 ? `${observation.changes} DOM change${observation.changes === 1 ? "" : "s"}` : "DOM changed"} after ${op}`,
      ),
    };
  const activity = activityEffect(observation);
  if (activity) return activity;
  if (observation.outcome === "unchanged" && (observation.requests ?? 0) > 0)
    return {
      effect: "unverifiable",
      evidence: shorten(
        `${observation.requests} request${observation.requests === 1 ? "" : "s"} after ${op}, no visible change`,
      ),
    };
  if (observation.outcome === "unchanged")
    return {
      effect: "suspected_noop",
      evidence: shorten(`no navigation, DOM change or request after ${op}`),
    };
  return { effect: "unverifiable", evidence: "the page could not be read after the step" };
}

/** The effect of a scroll: a moved scroll offset is its own readback. */
export function scrollEffect(scroll: {
  direction: string;
  moved: boolean;
  position: number;
}): EffectVerdict {
  return attachNext(
    scroll.moved
      ? {
          effect: "confirmed",
          evidence: shorten(`scrolled ${scroll.direction} to ${Math.round(scroll.position)}px`),
        }
      : {
          effect: "suspected_noop",
          evidence: shorten(`scroll ${scroll.direction} did not move the page (at the boundary)`),
        },
    { op: "scroll" },
  );
}

function quote(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(text.length > 80 ? text.slice(0, 77) + "..." : text);
}

/** The text a fill or paste should have left in the field, for its readback. */
export function expectedValue(step: BrowserStep): string | undefined {
  if (step.op === "fill") return step.value;
  if (step.op === "paste") return step.text;
  return undefined;
}

/** A real click that produced no navigation, DOM change or request is usually a miss. */
export function silentClickNote(element: BrowserElementTarget, child = false): string {
  const what =
    element.kind === "locator"
      ? `${element.role} "${element.name}"${element.scope ? ` in ${element.scope}` : ""}`
      : element.kind === "query"
        ? `${element.by} selector ${JSON.stringify(element.value)}`
        : element.kind === "ref"
          ? `element ${element.ref}`
          : element.kind === "point"
            ? "the clicked point"
            : `backend node ${element.backendNodeId}`;
  const why = child
    ? "nothing happened; a child element has the handler"
    : "nothing happened (no navigation, DOM change or network request)";
  // Keep the ways out: the handler may sit on a child, or need a real pointer event.
  return `clicked ${what}: ${why}. The link may be on a child element; try clicking the child, or a listener may need a pointer event: try page.clickAt(x, y)`;
}

/** The name a state read should look for after this element missed. */
export function elementQuery(element: BrowserElementTarget | undefined): string | undefined {
  if (!element) return undefined;
  if (element.kind === "locator") return element.name || undefined;
  if (element.kind === "query") return element.value;
  return undefined;
}
