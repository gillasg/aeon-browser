// The types of site-boosts/embed for host extensions, so they do not type-check this repo's
// source under their own settings. Keep in line with index.ts.

export declare const MESSAGE_PREFIX = "boosts.";

export type SiteRule = { type: string; value?: string };

export interface BoostEngineOptions {
  /** The content script the host built with site-boosts/embed-build (writeContent). */
  contentScript: string;
  /**
   * Answers boosts' site API calls (sb.api) itself, e.g. through the host's own site-to-api.
   * Without it they go to a site-to-api server set in the settings, or to a companion extension.
   */
  siteMapper?: (
    site: string,
    operation: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface BoostRunState {
  lastRun: { at: number; url: string } | null;
  lastError: { message: string; stack?: string; at: number; url: string } | null;
  tabs: number[];
  health: string;
}

export interface BoostSummary extends BoostRunState {
  id: string;
  name: string;
  enabled: boolean;
  sites: SiteRule[];
  parts: string[];
  updated: number;
}

export interface Warning {
  code: string;
  message: string;
}

export interface SavedBoost extends BoostSummary {
  warnings: Warning[];
}

export interface BoostEngine {
  list(url?: string): Promise<BoostSummary[]>;
  get(id: string): Promise<Record<string, unknown> | undefined>;
  /** Saves a boost (new without an id, replaced with one) and applies it in open tabs. */
  save(input: Record<string, unknown>): Promise<SavedBoost>;
  /** Live viewers boosts may push to (GM.liveView.push); their tokens stay in the worker. */
  rememberView(view: Record<string, unknown>): Promise<{ id: string }>;
  forgetView(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** The wire rules of the boosts active on this URL, as saved. */
  wireFor(url: string): Promise<unknown[]>;
}

export declare function startBoostEngine(options: BoostEngineOptions): BoostEngine;
