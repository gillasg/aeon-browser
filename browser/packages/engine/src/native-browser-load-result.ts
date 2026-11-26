import { isKernelErrorCode } from "./kernel-errors.js";
import { BrowserActionError } from "./native-browser-common.js";
import { pendingRequests, settleBrowserPage } from "./native-browser-navigation.js";

// How a page load ends: bounded at the caller's deadline with what is still loading, or at once
// with POLICY_BLOCKED when Chrome refused it (or a redirect hop) for policy reasons.

export interface IdleResult {
  idle: boolean;
  pending?: Array<{ url: string; ageMs: number }>;
  note?: string;
}

/**
 * Waits for the page to go quiet, but never past the caller's deadline. At the deadline it
 * resolves with what is still loading instead of failing: the page is usable.
 */
export async function waitForIdleUntil(tabId: number, deadline: number): Promise<IdleResult> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), remaining);
  });
  const settle =
    remaining > 0
      ? await Promise.race([settleBrowserPage({ tabId }, Math.min(remaining, 2_000)), capped])
      : undefined;
  clearTimeout(timer);
  if (settle?.why === "quiet") return { idle: true };
  return stillLoading(pendingRequests(tabId));
}

export function stillLoading(pending: Array<{ url: string; ageMs: number }>): IdleResult {
  const n = pending.length;
  return {
    idle: false,
    pending,
    note: `Still loading: ${n} request${n === 1 ? "" : "s"} pending; the page is usable`,
  };
}

/**
 * Why a page load failed, if it did. Only a navigation that timed out before committing fails;
 * requests still pending on a page that loaded (beacons, long polls) are not a failure.
 */
export function navigationFailure(ready: {
  timedOut: boolean;
  note?: string;
  pending?: Array<{ url: string; ageMs: number }>;
}): string | undefined {
  if (!ready.timedOut || !ready.note) return undefined;
  const loading = stillLoading(ready.pending ?? []).note ?? "";
  const reason = ready.note.endsWith(loading)
    ? ready.note.slice(0, ready.note.length - loading.length).replace(/;\s*$/, "")
    : ready.note;
  return reason ? reason.slice(0, 400) : undefined;
}

const POLICY_ERRORS: Array<[RegExp, string]> = [
  [/ERR_BLOCKED_BY_CLIENT/, "a site rule"],
  [/ERR_BLOCKED_BY_ADMINISTRATOR/, "an administrator policy"],
  [/ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_ORB/, "the site's response policy"],
];

/**
 * A navigation (or one of its redirect hops) that Chrome refused for policy reasons. It fails at
 * once with POLICY_BLOCKED instead of waiting out the navigate timeout.
 */
export function policyBlockedError(
  chromeError: string,
  url: string,
): BrowserActionError | undefined {
  const rule = POLICY_ERRORS.find(([pattern]) => pattern.test(chromeError))?.[1];
  if (!rule) return undefined;
  let host = url;
  try {
    host = new URL(url).hostname || url;
  } catch {
    // Not a URL: name it as given.
  }
  return new BrowserActionError(
    "POLICY_BLOCKED",
    `${host} is blocked by ${rule}; allow it in Settings → Sites`,
  );
}

export function hintEvaluateError(description: string): string {
  const text = String(description ?? "");
  if (/^ReferenceError/.test(text) && /\b(window|document|location|self|localStorage)\b/.test(text))
    return `${text}\nHint: this cell runs in the sandbox; use page.evaluate(...) or page.inspect(...) to run code in the page.`;
  if (
    /^TypeError/.test(text) &&
    /Cannot read properties of undefined \(reading 'querySelector'\)/.test(text)
  )
    return `${text}\nHint: this looks like page code running in the sandbox; use page.evaluate(...) or page.inspect(...).`;
  return text;
}

/**
 * An exception thrown by code running in the page: a coded one ("Error: TARGET_NOT_FOUND: …",
 * thrown by the page helpers) keeps its code; any other is the code's own error, not Chrome's.
 */
export function pageExceptionCode(detail: string): string {
  const head = /^(?:[A-Za-z]*Error: )?([A-Z][A-Z_]+)(?::|$)/.exec(detail)?.[1] ?? "";
  return isKernelErrorCode(head) ? head : "CODE_ERROR";
}
