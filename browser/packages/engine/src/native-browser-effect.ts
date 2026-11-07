// What an input step's result says it caused: a closed effect, with the evidence it rests on.
// The point is that "the click was delivered" and "the click did something" stop being mixed:
// confirmed needs readable evidence (a value read back, a navigation, a DOM change), a step that
// ran without evidence is unverifiable, and a bounded unchanged state is a suspected no-op rather
// than a failure. Cua Driver's ActionResult.effect, adapted to what Aeon can see in one step.
import { type BrowserElementTarget, type BrowserStep, NOOP_NEXT_CALL } from "@browserkit/protocol";

export type StepEffect = "confirmed" | "unverifiable" | "suspected_noop" | "refused";

export interface EffectVerdict {
  effect: StepEffect;
  evidence: string;
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
}

const MAX_EVIDENCE = 200;

const shorten = (text: string) =>
  text.length > MAX_EVIDENCE ? text.slice(0, MAX_EVIDENCE - 3) + "..." : text;

/** The effect of a step that did not run: it was refused, and the code is the evidence. */
export function refusedEffect(code: string): EffectVerdict {
  return { effect: "refused", evidence: shorten(code || "refused") };
}

/**
 * The effect of a click, fill or paste, from what the page showed. A fill with its value read
 * back is confirmed even when nothing else changed (typing into a field is its own evidence).
 */
export function inputStepEffect(
  op: string,
  observation: StepObservation,
  expected?: string,
): EffectVerdict {
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
  return scroll.moved
    ? {
        effect: "confirmed",
        evidence: shorten(`scrolled ${scroll.direction} to ${Math.round(scroll.position)}px`),
      }
    : {
        effect: "suspected_noop",
        evidence: shorten(`scroll ${scroll.direction} did not move the page (at the boundary)`),
      };
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
export function silentClickNote(element: BrowserElementTarget): string {
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
  return `clicked ${what}: nothing happened (no navigation, DOM change or network request). The card's link may be on a child element; try clicking the child, or a listener may need a pointer event: try page.clickAt(x, y). Next: ${NOOP_NEXT_CALL}`;
}
