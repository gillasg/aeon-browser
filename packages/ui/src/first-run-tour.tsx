import { useState, type ReactElement } from "react";

// A short tour the first time home opens. It replaces the old action-bar note, whose message is
// now one of the steps. Settings can show it again.

export const TOUR_KEY = "aeonTour";

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Call Aeon on any page",
    body: "Press Ctrl+Shift+Space on any page. Aeon opens bottom-left with the page as context; press it again to close.",
  },
  {
    title: "Watch it work",
    body: "A purple glow marks every tab Aeon works in. Drag the orb anywhere; ⇱ moves the chat to the side panel.",
  },
  {
    title: "Chrome's “acting in this tab” bar is normal",
    body: "Chrome shows it while Aeon works in a tab. Cancel on that bar stops Aeon too.",
  },
  {
    title: "Everything in one box",
    body: "Ctrl+K on the new tab page lists what Aeon can do on your sites. Ask it to tell you when something changes and it watches for you.",
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
