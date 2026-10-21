import { useState, type ReactElement } from "react";

// A short tour the first time home opens. It replaces the old action-bar note, whose message is
// now one of the steps. Settings can show it again.

export const TOUR_KEY = "aeonTour";

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Call Aeon on any page",
    body: "Press Ctrl+Shift+Space anywhere. Aeon opens at your mouse with the page as context.",
  },
  {
    title: "Watch it work, or take over",
    body: "The orb becomes Aeon's cursor so you can see each step. Press Take over to drive yourself, then Resume.",
  },
  {
    title: "Chrome's “acting in this tab” bar is normal",
    body: "Chrome shows it while Aeon works in a tab. Cancel on that bar stops Aeon too.",
  },
  {
    title: "Watch what changes",
    body: "Press Watch on a result and Aeon checks it every 15 minutes, telling you only when something changes.",
  },
];

export function FirstRunTour(): ReactElement | null {
  const [step, setStep] = useState(() => (seen() ? -1 : 0));
  if (step < 0) return null;
  const finish = (): void => {
    try {
      localStorage.setItem(TOUR_KEY, "done");
    } catch {
      /* A private window may reject storage; still close the tour. */
    }
    setStep(-1);
  };
  const current = STEPS[step] ?? STEPS[0];
  const last = step === STEPS.length - 1;
  return (
    <section className="first-run-tour" role="dialog" aria-label="Welcome to Aeon">
      <p className="tour-count">
        {step + 1} of {STEPS.length}
      </p>
      <h2>{current?.title}</h2>
      <p>{current?.body}</p>
      <div className="tour-actions">
        <button type="button" className="quiet-button" onClick={finish}>
          Skip
        </button>
        {step > 0 && (
          <button type="button" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button
          type="button"
          className="tour-next"
          onClick={() => (last ? finish() : setStep(step + 1))}
        >
          {last ? "Done" : "Next"}
        </button>
      </div>
    </section>
  );
}

export function resetTour(): void {
  try {
    localStorage.removeItem(TOUR_KEY);
  } catch {
    /* Nothing to reset. */
  }
}

function seen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === "done";
  } catch {
    return true;
  }
}
