// The proof that a run came from a compiled site, in fields a caller can show: how long it took,
// that no model was involved, how it was served, and the one-line command that serves the site
// to another agent. A second run of a learned site answers in well under a second; this is how
// that is said ("0.4s · no model · API").

import type { AbilityVia } from "./abilities.js";
import { siteName } from "./registry.js";

export interface RunReceipt {
  /** Served by a compiled way (the site's API), not the page and not a model. */
  compiled: boolean;
  /** How long the run took, in milliseconds. */
  elapsedMs: number;
  /** The command that serves this site's tools to another agent. */
  mcpCommand: string;
  /** One line for people: `0.4s · no model · API`. */
  receipt: string;
}

const VIA_LABEL: Record<AbilityVia, string> = {
  api: "API",
  script: "script",
  page: "page",
  steps: "steps",
};

/** `graft mcp example.com`: the one line that gives another agent this site's tools. */
export function mcpCommandForSite(site: string): string {
  return `graft mcp ${siteName(site)}`;
}

/** `0.4s` under ten seconds, whole seconds after. */
export function elapsedLabel(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function runReceipt(site: string, via: AbilityVia, elapsedMs: number): RunReceipt {
  return {
    compiled: via === "api",
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    mcpCommand: mcpCommandForSite(site),
    receipt: `${elapsedLabel(elapsedMs)} · no model · ${VIA_LABEL[via] ?? via}`,
  };
}
