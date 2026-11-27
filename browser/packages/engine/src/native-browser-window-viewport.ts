// openTab({window: {width, height}}) sizes the outer window; Chrome's frame, tab strip and
// toolbar eat part of it. When the page's own innerWidth/innerHeight comes out different, the
// viewport is overridden to the size asked for, and recorded so a debugger re-attach keeps it.
import { send } from "./cdp/send.js";
import { noteDeviceEmulation } from "./native-browser-session.js";

type Send = (
  debuggee: chrome.debugger.Debuggee,
  method: string,
  params?: object,
  options?: { label?: string },
) => Promise<unknown>;

export interface ViewportSize {
  width: number;
  height: number;
}

/** True when the page's viewport is already the size asked for (within a pixel). */
export function viewportMatches(actual: ViewportSize, want: ViewportSize): boolean {
  return Math.abs(actual.width - want.width) <= 1 && Math.abs(actual.height - want.height) <= 1;
}

async function innerSize(tabId: number, sendFn: Send): Promise<ViewportSize | undefined> {
  const reply = (await sendFn(
    { tabId },
    "Runtime.evaluate",
    { expression: "({width: innerWidth, height: innerHeight})", returnByValue: true },
    { label: "windowViewport" },
  ).catch(() => undefined)) as { result?: { value?: ViewportSize } } | undefined;
  const value = reply?.result?.value;
  return value && value.width > 0 && value.height > 0 ? value : undefined;
}

/** Makes the tab's viewport the asked-for size. Returns true when it set an override. */
export async function matchWindowViewport(
  tabId: number,
  want: ViewportSize,
  sendFn: Send = send as Send,
): Promise<boolean> {
  const actual = await innerSize(tabId, sendFn);
  if (!actual || viewportMatches(actual, want)) return false;
  const params = { width: want.width, height: want.height, deviceScaleFactor: 0, mobile: false };
  await sendFn({ tabId }, "Emulation.setDeviceMetricsOverride", params, {
    label: "windowViewport",
  });
  noteDeviceEmulation(tabId, "Emulation.setDeviceMetricsOverride", params);
  return true;
}
