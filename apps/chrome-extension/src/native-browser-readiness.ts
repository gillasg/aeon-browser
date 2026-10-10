import { settleBrowserPage } from "./native-browser-settle.js";
export async function waitPageInteractive(tabId: number, timeoutMs = 2000): Promise<boolean> {
  return (await settleBrowserPage({ tabId }, timeoutMs)).why === "quiet";
}

export async function viewportFingerprint(debuggee: chrome.debugger.Debuggee): Promise<string> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${layoutProbe.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: string }; exceptionDetails?: unknown };
  if (result.exceptionDetails || typeof result.result?.value !== "string" || !result.result.value)
    throw new Error("STALE_REF");
  return result.result.value;
}
function layoutProbe(): string {
  const elements = [...document.querySelectorAll("*")];
  const boxes: unknown[] = [];
  for (const el of elements) {
    const box = el.getBoundingClientRect();
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      box.bottom < 0 ||
      box.top > innerHeight ||
      box.right < 0 ||
      box.left > innerWidth ||
      getComputedStyle(el).visibility === "hidden"
    )
      continue;
    boxes.push([
      el.tagName,
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("href"),
      (el.textContent ?? "").trim().slice(0, 80),
      ...[box.x, box.y, box.width, box.height].map(Math.round),
    ]);
    if (boxes.length >= 2000) return "";
  }
  return JSON.stringify([scrollX, scrollY, innerWidth, innerHeight, visualViewport?.scale, boxes]);
}
