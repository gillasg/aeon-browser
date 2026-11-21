import { useState, type ReactElement } from "react";

// The whole first-run experience: one line about Aeon and three tasks that need no site account.
// No tour, no dialog. A click puts the task in the ask box, ready to send (or to send after the
// one-time model connect below). It goes for good once any task is sent, picked or typed.
// Settings can bring it back with "Welcome / Show again".

const KEY = "aeonWelcome";

const EXAMPLES = [
  "Summarise the page I have open in five bullets",
  "List every link on this page",
  "Tell me when this page changes",
] as const;

export function NewUserWelcome({
  needsModel,
  onExample,
}: {
  needsModel: boolean;
  onExample(text: string): void;
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
        Aeon is a browser agent that works in your Chrome.
        {needsModel ? " Connect a model below once, then try one of these:" : " Try one of these:"}
      </p>
      <div className="new-user-examples">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" onClick={() => pick(example)}>
            {example}
          </button>
        ))}
      </div>
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
