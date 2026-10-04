import type { ReactElement } from "react";
import { orbitBack, orbitFront, orbitCircle } from "./orbit-geometry.js";
export function AeonOrbit(): ReactElement {
  return (
    <svg
      width="100"
      height="100"
      viewBox="0 0 100 100"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={orbitBack} />
      <circle {...orbitCircle} />
      <path d={orbitFront} />
    </svg>
  );
}
