import { useState, type ReactElement } from "react";

// The whole first-run experience, in the side panel's idle canvas: up to three quiet suggestion
// rows under the "Do anything on …" line. No tour, no dialog. A click puts the task in
// the ask box, ready to send (or to send after the one-time model connect below); it never sends.
// It goes for good once any task is sent, picked or typed. Settings can bring it back with
// "Welcome / Show again".

const KEY = "aeonWelcome";

export const WELCOME_EXAMPLES = [
  "Tell me when the price on this page drops",
  "Fill this form with my details",
  "Hide the parts of this site I never use",
] as const;

export function NewUserWelcome({
  needsModel,
  onExample,
  onLearn,
}: {
  needsModel: boolean;
  onExample(text: string): void;
  /** "What can Aeon do?": the Learn page. */
  onLearn?: (() => void) | undefined;
}): ReactElement | null {
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "done";
    } catch {
      return true; // A private window may reject storage; never block the home page.
    }
  });
  if (seen) return null;
  const pick = (text: string): void => {
    markWelcomeDone();
    setSeen(true);
    onExample(text);
  };
  return (
    <section className="new-user-welcome" aria-label="Welcome to Aeon">
      {needsModel && <p className="new-user-line">Connect a model below once, then try one:</p>}
      <ul className="new-user-examples">
        {WELCOME_EXAMPLES.map((example) => (
          <li key={example}>
            <button type="button" onClick={() => pick(example)}>
              {example}
            </button>
          </li>
        ))}
      </ul>
      {onLearn && (
        <button type="button" className="new-user-learn" onClick={onLearn}>
          What can Aeon do?
        </button>
      )}
    </section>
  );
}

/** Called when any task is sent, so a user who types their own never sees the examples again. */
export function markWelcomeDone(): void {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    /* Nothing to remember. */
  }
}

export function resetWelcome(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Nothing to reset. */
  }
}
