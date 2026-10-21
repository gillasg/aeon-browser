import { useState, type ReactElement } from "react";

// The first time a run opens the action bar, explain it before the user sees it. Dismissed once,
// then never shown again in this profile.
export function ActionBarNote(): ReactElement | null {
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem("aeon-action-bar-note") !== "dismissed";
    } catch {
      return true;
    }
  });
  if (!show) return null;
  const dismiss = (): void => {
    try {
      localStorage.setItem("aeon-action-bar-note", "dismissed");
    } catch {
      // A private window may reject storage; still dismiss this view.
    }
    setShow(false);
  };
  return (
    <div className="action-bar-note" role="note">
      <span>
        Chrome shows an &ldquo;acting in this tab&rdquo; bar while Aeon works. That is normal
        &mdash; Cancel stops it.
      </span>
      <button type="button" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
