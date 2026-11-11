import { failureTitle } from "./failure-title.js";

/** One line above the cursor's ask field. `more` links to the side panel for the rest. */
export interface BoxLine {
  title?: string;
  text: string;
  more: boolean;
}

export function boxLine(run: {
  status: string;
  label: string;
  error?: string;
  answer?: string;
}): BoxLine | null {
  if (run.status === "idle") return null;
  if (run.status === "error")
    return { title: failureTitle(run.error ?? run.label), text: run.error ?? "", more: true };
  if (run.status === "done") return doneLine(run);
  const text = run.label.trim();
  return text ? { text, more: false } : null;
}

function doneLine(run: { label: string; answer?: string }): BoxLine | null {
  const text = (run.answer ?? "").trim() || run.label.trim();
  return text ? { text, more: true } : null;
}
