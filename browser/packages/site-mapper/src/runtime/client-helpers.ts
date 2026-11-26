// Small pieces of the site client kept apart so its class stays readable.
import { type Challenge, observeExchange } from "../challenge.js";
import { recordChallenge } from "../circuit-breaker.js";
import { notePaceLimit } from "../pace.js";
import { readSession } from "../registry.js";
import type { SiteModel } from "../types.js";
import { isRateLimited } from "./limits.js";
import type { RuntimeResponse } from "./request.js";
import type { SessionFile } from "./session.js";
import { exportSession } from "./session-export.js";
import type { SiteMapperOptions } from "./site-mapper.js";

/** Halves the site's pace on a 429 or a challenge page. Returns the wall when there was one. */
export function paceOnChallenge(
  site: string,
  response: RuntimeResponse,
  account?: string,
): Challenge | undefined {
  const wall = observeExchange(site, response);
  // I-8: the first wall pauses direct replay for this (site, account) for 24 hours.
  if (wall) recordChallenge(site, wall, account);
  if (wall || isRateLimited(response)) notePaceLimit(site);
  return wall;
}

export async function initialSession(
  model: SiteModel,
  options: SiteMapperOptions,
): Promise<SessionFile | undefined> {
  if (options.session === false) return undefined;
  return options.session ?? (await readSession(model.site));
}

/** A session the user exported is renewed from their browser when it expires or is refused. */
export function sessionRefresher(
  model: SiteModel,
  options: SiteMapperOptions,
): (() => Promise<SessionFile | undefined>) | undefined {
  if (options.refreshSession === false) return undefined;
  return (
    options.refreshSession ?? (async () => (await exportSession(model, options.bridge)).session)
  );
}
