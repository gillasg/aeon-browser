import { send } from "./cdp/send.js";

// A bot-check interstitial (Cloudflare's "Just a moment...", its cf-challenge form) is quiet on
// the network while its script works out the challenge, then reloads into the real page. A sleep
// that ends when the page goes quiet would end in the middle of that check, so while the page is
// one of these the settle step does not report the page as settled.

/** Runs in the page: whether it is a known bot-check interstitial. Exported for tests. */
export const CHALLENGE_PAGE_EXPRESSION = `(() => {
  const title = String(document.title || "");
  if (/^(just a moment|attention required|checking your browser|please wait|one moment, please|ddos-guard)/i.test(title.trim())) return true;
  return Boolean(document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification, #challenge-running, #cf-wrapper #challenge-stage, script[src*="/cdn-cgi/challenge-platform/"], #px-captcha, #sec-if-cpt-container'));
})()`;

/** Whether the tab shows a bot-check interstitial; false when it cannot tell. */
export async function onChallengePage(debuggee: chrome.debugger.Debuggee): Promise<boolean> {
  const result = (await send(
    debuggee,
    "Runtime.evaluate",
    { expression: CHALLENGE_PAGE_EXPRESSION, returnByValue: true, silent: true },
    { label: "challengePage", ms: 1_000 },
  ).catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
  return result?.result?.value === true;
}
