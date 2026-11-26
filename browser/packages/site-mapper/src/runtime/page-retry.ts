// A plain-HTTP read that hits a rate limit or a bot wall goes to the page once, at once: the
// site throttles Node's TLS, not the user's browser, so backing off on the direct path only
// burns time (Gauntlet #2 saw 30 s loops before a page call that answered in one).
import { detectChallenge } from "../challenge.js";
import { isRateLimited } from "./limits.js";
import type { RuntimeResponse } from "./request.js";

/** True for a direct answer the page should retry instead: a 429 or a bot wall. */
export function directWall(response: RuntimeResponse): boolean {
  return isRateLimited(response) || detectChallenge(response) !== undefined;
}

/** The page's answer to a walled direct read, or the direct answer when the page cannot help. */
export async function pageAfterWall<T extends { name: string }>(
  direct: RuntimeResponse,
  page: T,
  send: () => Promise<RuntimeResponse>,
): Promise<{ response: RuntimeResponse; transport: T } | undefined> {
  try {
    const response = await send();
    response.notes = [
      ...(response.notes ?? []),
      `Plain HTTP answered ${direct.status} (a limit or bot wall), so the call went through the browser.`,
    ];
    return { response, transport: page };
  } catch {
    return undefined;
  }
}
