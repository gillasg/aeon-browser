import { viewportFingerprint } from "./native-browser-navigation.js";
interface Capture {
  viewport: { width: number; height: number };
  scrollX: number;
  scrollY: number;
  fingerprint: string;
  dataBase64: string;
}
export async function captureViewport(debuggee: chrome.debugger.Debuggee): Promise<Capture> {
  const metrics = (await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")) as {
    cssVisualViewport?: {
      clientWidth?: number;
      clientHeight?: number;
      pageX?: number;
      pageY?: number;
    };
  };
  await chrome.debugger.sendCommand(debuggee, "Page.enable");
  const fingerprint = await viewportFingerprint(debuggee);
  const capture = (await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 60,
    captureBeyondViewport: false,
  })) as { data?: string };
  const view = metrics.cssVisualViewport ?? {};
  const width = Math.floor(view.clientWidth ?? 0),
    height = Math.floor(view.clientHeight ?? 0);
  if (!capture.data || width < 1 || height < 1 || capture.data.length > 1_500_000)
    throw new Error("UNSUPPORTED");
  if ((await viewportFingerprint(debuggee)) !== fingerprint) throw new Error("STALE_REF");
  return {
    viewport: { width, height },
    scrollX: view.pageX ?? 0,
    scrollY: view.pageY ?? 0,
    fingerprint,
    dataBase64: capture.data,
  };
}
