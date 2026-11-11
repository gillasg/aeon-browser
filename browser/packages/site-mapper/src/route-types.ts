// A route is one successful run, compiled. Slots stand in for values. Secrets are never stored.

export interface TargetWithFallbacks {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export interface RouteStep {
  kind: string;
  target?: TargetWithFallbacks;
  args?: string[];
  onPageType: string;
  expectEffect: "confirmed" | "unverifiable" | "suspected_noop" | "refused";
  expectRequest?: { method: string; path: string };
}

export interface RouteInput {
  name: string;
  /** Empty when the value was a secret: the slot is kept, the secret is not. */
  example: string;
}

export interface Route {
  id: string;
  site: string;
  signature: string[];
  inputs: RouteInput[];
  /** One record per successful run, so two different inputs can promote the route. */
  inputHistory: Record<string, string>[];
  steps: RouteStep[];
  reads: string[];
  writes: boolean;
  okRuns: number;
  lastOkAt: string;
  summary: string;
  cell: string;
  /** Two prompt values could fill one slot. Replay starts at rung 1. */
  ambiguous: boolean;
  expiresAt: string;
  abilityId?: string;
  fingerprint: string;
  /** The run was a watcher, trigger or queue. Promotion does not wait for a second success. */
  watcher?: boolean;
}

export interface ObservedStep {
  id: string;
  kind: string;
  target?: TargetWithFallbacks;
  args?: string[];
  effect?: RouteStep["expectEffect"];
  write?: boolean;
  sensitive?: boolean;
  pageType?: string;
  url?: string;
  evidence?: {
    request?: { method: string; path: string; status: number };
    navigated?: string;
    download?: { name: string };
    valueRead?: boolean;
  };
}
