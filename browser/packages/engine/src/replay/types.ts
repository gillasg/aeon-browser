// Replay with guards. The host is the page: unit tests pass a fake one, the daemon passes the
// user's tab. A third argument is what lets this run without Chrome.

import type { StepEffect, StepEvent } from "@browserkit/protocol";

export interface TargetWithFallbacks {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export interface RouteStep {
  kind: StepEvent["kind"];
  target?: TargetWithFallbacks;
  args?: string[];
  onPageType: string;
  expectEffect: StepEvent["effect"];
  expectRequest?: { method: string; path: string };
}

export interface Route {
  id: string;
  site: string;
  signature: string[];
  inputs: { name: string; example: string }[];
  steps: RouteStep[];
  reads: string[];
  writes: boolean;
  okRuns: number;
  lastOkAt: string;
  /** Two prompt values could fill one slot. */
  ambiguous?: boolean;
  summary?: string;
  cell?: string;
}

export type ReplayResult =
  | { done: true; outputs: unknown[]; steps: StepEvent[] }
  | {
      done: false;
      at: number;
      why: string;
      state: string;
      remaining: RouteStep[];
      steps: StepEvent[];
    };

export interface PageControl {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export interface ReplayHost {
  pageType(): Promise<string>;
  state(): Promise<string>;
  controls(): Promise<PageControl[]>;
  act(step: RouteStep): Promise<{ effect: StepEffect; output?: unknown; event: StepEvent }>;
}

export interface RouteDraft {
  site: string;
  summary: string;
  cell: string;
  ranAt: string;
}
