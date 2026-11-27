import type { Transport } from "./transports.js";

// Which transport makes a read. When a browser is connected, every call goes out from the
// site's own tab: the site sees the user's real browser (its TLS, headers, cookies and
// Sec-Fetch-* values), never a script. Direct runs only with no browser, or when asked for.

export interface TransportChoice {
  mode: "auto" | "page" | "direct";
  page: Transport;
  direct: Transport;
  /** A header recorded sealed or redacted: only real in the page. */
  pageHeaders: boolean;
  /** A tripped breaker runs the call in the live page. */
  paused: boolean;
  needsBrowser: () => Promise<boolean>;
  preferred: () => Promise<"page" | "direct" | undefined>;
}

/** The transport a read starts on. */
export async function chooseTransport(choice: TransportChoice): Promise<Transport> {
  if (choice.mode === "page") return choice.page;
  if (choice.mode === "direct") return choice.direct;
  if (await browserConnected(choice.page)) return choice.page;
  if (choice.pageHeaders || choice.paused) return choice.page;
  if (await choice.needsBrowser()) return choice.page;
  // The remembered preference only ever says page (see rememberedTransport).
  return (await choice.preferred()) === "page" ? choice.page : choice.direct;
}

/** True when the page transport has a browser to call from. */
export async function browserConnected(page: Transport): Promise<boolean> {
  try {
    return (await page.connected?.()) === true;
  } catch {
    return false;
  }
}

/** What may be remembered: a call may move an operation to the page, never back to direct. */
export function rememberedTransport(name: "page" | "direct"): "page" | undefined {
  return name === "page" ? "page" : undefined;
}
