import { useState, type ReactElement } from "react";

// The whole first-run experience, on the Manage tab's first open and in the side panel's empty
// state: one line about Aeon and four general tasks. No tour, no dialog. A click puts the task in
// the ask box, ready to send (or to send after the one-time model connect below); it never sends.
// It goes for good once any task is sent, picked or typed. Settings can bring it back with
// "Welcome / Show again".

const KEY = "aeonWelcome";

export const WELCOME_EXAMPLES = [
  "Turn this site into an API I can call",
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
      <p className="new-user-line">
        Aeon works in your Chrome, with your logins.
        {needsModel ? " Connect a model below once, then try one of these:" : " Try one of these:"}
      </p>
      <div className="new-user-examples">
        {WELCOME_EXAMPLES.map((example) => (
          <button key={example} type="button" onClick={() => pick(example)}>
            {example}
          </button>
        ))}
      </div>
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
