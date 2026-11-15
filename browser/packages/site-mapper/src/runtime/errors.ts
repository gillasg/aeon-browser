// The errors a site call can raise, and what kind of failure each one is, so callers know
// whether to sign in, hand off or repair.

import type { Challenge } from "../challenge.js";
import { BrowserNotConnected } from "./bridge.js";
import { MissingParams, type RuntimeResponse } from "./request.js";

export class HttpError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly response: RuntimeResponse,
  ) {
    const detail =
      response.json !== undefined ? JSON.stringify(response.json) : (response.text ?? "");
    super(`${operationId} answered HTTP ${response.status}: ${detail.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/** The site refused the call as signed out (401/403 even after renewing auth). */
export class SignedOut extends HttpError {
  constructor(operationId: string, response: RuntimeResponse) {
    super(operationId, response);
    this.name = "SignedOut";
    // A 401/403 also comes back when the site wants a sign-in header its own code adds; say both.
    this.message = `The site refused the call as not signed in: ${this.message}. Either the browser is signed out of it (sign in, then call again), or the site adds a sign-in header browserkit has not seen yet: use the site in a tab once so its header can be borrowed, or read the page instead.`;
  }
}

/** The site refused the call with a bot wall (Cloudflare, DataDome, PerimeterX, Akamai). */
export class Challenged extends HttpError {
  constructor(
    operationId: string,
    response: RuntimeResponse,
    public readonly wall: Challenge,
  ) {
    super(operationId, response);
    this.name = "Challenged";
    this.message = `A ${wall.vendor} bot wall answered ${operationId} (${wall.evidence}). There is nothing to repair: open the site in a tab, clear the check like a person would, then call again. Re-recording only teaches the wall.`;
  }
}

/** A write reached the API runtime. Writes go through the site's page UI, never through SiteMapper. */
export class WriteThroughApi extends Error {
  constructor(operationId: string) {
    super(`${operationId} changes state; writes go through the site's page UI`);
    this.name = "WriteThroughApi";
  }
}

export type ErrorKind =
  "signed-out" | "challenged" | "missing-input" | "browser-offline" | "broken" | "failed";

/** What kind of failure an error is, so callers know what to do next. */
export function errorKind(error: unknown): ErrorKind {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause instanceof Error) return errorKind(cause);
  if (error instanceof Challenged) return "challenged";
  if (error instanceof SignedOut) return "signed-out";
  if (error instanceof MissingParams) return "missing-input";
  if (error instanceof BrowserNotConnected) return "browser-offline";
  if (error instanceof HttpError) return "broken";
  return "failed";
}
