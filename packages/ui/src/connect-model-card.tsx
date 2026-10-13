import type { ReactElement } from "react";

export interface ModelLoginState {
  /** The sign-in page is open; Aeon refreshes its models when the user comes back. */
  waiting: boolean;
  error?: string | undefined;
}

/**
 * Shown when no AI model is connected: one button opens the sign-in page (every provider Pi
 * supports, subscriptions or API keys). The models appear by themselves once the user signs in.
 */
export function ConnectModelCard({
  state,
  onConnect,
}: {
  state: ModelLoginState;
  onConnect(): void;
}): ReactElement {
  return (
    <div className="connect-model" role="region" aria-label="Connect an AI model">
      <div className="connect-model-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z" />
          <path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
        </svg>
      </div>
      <div className="connect-model-body">
        <strong>{state.waiting ? "Finish signing in" : "Connect an AI model to start"}</strong>
        <p>
          {state.waiting
            ? "Complete the sign-in on the page that just opened. Aeon picks it up automatically."
            : "Sign in with Claude, ChatGPT or GitHub Copilot, or add an API key from 40+ providers. You only do this once."}
        </p>
        {state.error && (
          <p className="connect-model-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
      <button
        type="button"
        className={state.waiting ? "connect-model-button secondary" : "connect-model-button"}
        onClick={onConnect}
      >
        {state.waiting ? (
          <>
            <span className="connect-model-spinner" aria-hidden="true" />
            Open sign-in again
          </>
        ) : (
          "Connect a model"
        )}
      </button>
    </div>
  );
}
