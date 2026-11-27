import type { ReactElement } from "react";
import { GraftMark } from "./graft-mark.js";
export function GraftWordmark(): ReactElement {
  return (
    <svg className="graft-wordmark" viewBox="0 0 210 42" role="img" aria-label="Graft">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="square"
        strokeLinejoin="miter"
      >
        <path d="M30 7H6v27h24V21H19M44 34V7h18v13H44M54 20l10 14M74 34 88 7l14 27M79 25h18M114 34V7h20M114 20h16M144 7h26M157 7v27" />
      </g>
      <g transform="translate(176 4) scale(.34)">
        <GraftMark />
      </g>
    </svg>
  );
}
