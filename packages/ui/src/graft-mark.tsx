import type { ReactElement } from "react";

// The Graft mark: one diagonal stick, split by an angled splice gap.
const markPath =
  "M22.1 68.7 31.3 77.9 57.8 51.4 38.5 52.3ZM61.5 47.7 77.9 31.3 68.7 22.1 42.2 48.6Z";

export function GraftMark(): ReactElement {
  return (
    <svg width="100" height="100" viewBox="0 0 100 100" aria-hidden="true">
      <path d={markPath} fill="currentColor" />
    </svg>
  );
}
