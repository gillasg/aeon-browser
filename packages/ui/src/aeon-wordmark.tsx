import type { ReactElement } from "react";
import { AeonOrbit } from "./aeon-orbit.js";
export function AeonWordmark(): ReactElement {
  return (
    <svg className="aeon-wordmark" viewBox="0 0 210 42" role="img" aria-label="Aeon">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="square"
        strokeLinejoin="miter"
      >
        <path d="M3 34 18 7l15 27M51 7H70M51 7v27h19M51 20h16M159 34V7l24 27V7" />
      </g>
      <g transform="translate(92 -2) scale(.46)">
        <AeonOrbit />
      </g>
    </svg>
  );
}
