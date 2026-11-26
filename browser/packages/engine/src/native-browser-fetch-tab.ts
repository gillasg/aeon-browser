// browser.fetch through a tab: an MV3 service worker sees every redirect as an opaque one with no
// Location, so it cannot check the next hop before following it. When Aeon already owns a tab on
// the request's origin, the request is re-issued in that tab, where the browser follows the
// redirect under its own same-origin and CORS rules, and the final address is checked before
// any of the body is returned.
import { assertBrowserNetwork } from "./native-browser-dns.js";

const MAX_TAB_BYTES = 16_000_000;

/** Which tabs Aeon owns (set by the tab tracker; tests set their own). */
let ownsTab: (tabId: number) => boolean = () => false;

export function setFetchTabOwner(owner: (tabId: number) => boolean): void {
  ownsTab = owner;
}

export interface TabFetchReply {
  status: number;
  url: string;
  redirected: boolean;
  headers: [string, string][];
  base64: string;
  tooLarge?: boolean;
}

/** An Aeon tab whose page is on `origin`, if there is one. */
export async function ownedTabOn(origin: string): Promise<number | undefined> {
  if (!chrome.tabs?.query) return undefined;
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (tab.id === undefined || !ownsTab(tab.id)) continue;
    try {
      if (new URL(tab.url ?? "").origin === origin) return tab.id;
    } catch {
      // Not a web page.
    }
  }
  return undefined;
}

export function redirectRefusal(url: URL): Error {
  return new Error(
    `REDIRECT_UNCHECKED: ${url.href} redirects to an address that cannot be checked first; ` +
      `open the site once, or fetch ${url.href} with page.request`,
  );
}

interface TabInit {
  method: string;
  headers: [string, string][];
  body?: string;
  credentials: RequestCredentials;
}

/**
 * Runs in the page. A fresh same-origin iframe gives an untouched fetch, so a site that wraps
 * window.fetch neither sees nor changes this request; window.fetch is the fallback.
 */
async function pageFetch(url: string, init: TabInit, max: number): Promise<TabFetchReply> {
  const scope = globalThis as unknown as {
    document?: Document;
    fetch: typeof fetch;
  };
  let run: typeof fetch = scope.fetch.bind(globalThis);
  let frame: HTMLIFrameElement | undefined;
  try {
    const doc = scope.document;
    if (doc?.documentElement) {
      frame = doc.createElement("iframe");
      frame.style.display = "none";
      doc.documentElement.appendChild(frame);
      const inner = frame.contentWindow as unknown as { fetch?: typeof fetch } | null;
      if (inner?.fetch) run = inner.fetch.bind(inner);
    }
  } catch {
    // Keep window.fetch.
  }
  try {
    const response = await run(url, { ...init, redirect: "follow" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    if (bytes.byteLength <= max)
      for (let index = 0; index < bytes.byteLength; index += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return {
      status: response.status,
      url: response.url,
      redirected: response.redirected,
      headers: [...response.headers],
      base64: btoa(binary),
      ...(bytes.byteLength > max ? { tooLarge: true } : {}),
    };
  } finally {
    frame?.remove();
  }
}

/** The request re-issued in `tabId`, its final address checked before the body is handed back. */
export async function fetchInTab(
  tabId: number,
  url: URL,
  init: RequestInit,
  check: ((url: string) => void | Promise<void>) | undefined,
): Promise<{ response: Response; finalUrl: string; redirected: boolean }> {
  const tabInit: TabInit = {
    method: String(init.method ?? "GET"),
    headers: [...new Headers(init.headers)],
    ...(typeof init.body === "string" ? { body: init.body } : {}),
    credentials: init.credentials ?? "include",
  };
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: pageFetch,
    args: [url.href, tabInit, MAX_TAB_BYTES],
  });
  const reply = results?.[0]?.result as TabFetchReply | undefined;
  if (!reply) throw new Error(`browser.fetch could not run in the tab on ${url.origin}`);
  const finalUrl = reply.url || url.href;
  try {
    await assertBrowserNetwork(finalUrl);
    await check?.(finalUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The body never leaves this function.
    throw new Error(`${message} (${url.href} redirected to ${finalUrl}; body discarded)`);
  }
  if (reply.tooLarge) throw new Error(`browser.fetch: ${finalUrl} is larger than 16 MB`);
  const bytes = Uint8Array.from(atob(reply.base64), (char) => char.charCodeAt(0));
  const nullBody = [101, 204, 205, 304].includes(reply.status);
  const response = new Response(nullBody ? null : bytes, {
    status: reply.status,
    headers: reply.headers,
  });
  return { response, finalUrl, redirected: reply.redirected || finalUrl !== url.href };
}
