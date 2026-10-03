import type { BrowserExecutorRequest, BrowserExecutorResult } from "@pippin/protocol";
import { withBrowserDebugger } from "./native-browser-session.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { readDiagnostics } from "./native-browser-diagnostics.js";
import { navigateReady } from "./native-browser-navigation.js";
import { executeSiteScript } from "./site-script-runtime.js";
import { assertRequestActive } from "./native-browser-request-lifecycle.js";
import { sameTarget, safePage } from "./native-browser-common.js";
import { browserPopups } from "./native-browser-popup.js";
type ExtraRequest = BrowserExecutorRequest & {
  step: Extract<
    BrowserExecutorRequest["step"],
    { op: "read" | "wait" | "navigate" | "diagnostics" | "siteScript" | "popups" }
  >;
};
export async function performExtra(
  request: ExtraRequest,
  revalidate: (request: BrowserExecutorRequest, tabId: number) => Promise<void>,
): Promise<BrowserExecutorResult> {
  const tabId = request.step.target.tabId;
  let data: unknown;
  if (request.step.op === "siteScript") {
    await revalidate(request, tabId);
    data = await executeSiteScript(
      request.step.action,
      tabId,
      request.step.definition,
      request.step.scriptId,
      () => revalidate(request, tabId),
    );
  } else
    data = await withBrowserDebugger(tabId, async (debuggee) => {
      await revalidate(request, tabId);
      if (request.step.op === "navigate") return navigateReady(tabId, request.step.url);
      if (request.step.op === "diagnostics") return readDiagnostics(tabId, request.step.clear);
      if (request.step.op === "popups") return { tabs: await browserPopups(tabId) };
      return readOrWait(debuggee, request, () => revalidate(request, tabId));
    });
  const tab = await refreshInventoryTab(tabId);
  assertRequestActive(request);
  if (!tab || !sameTarget(tab.target, request.step.target) || !safePage(tab.url))
    throw new Error("TARGET_LOST");
  const encoded = JSON.stringify(data);
  if (encoded && encoded.length > 160_000)
    data = { truncated: true, message: "Result exceeded 160 KB; narrow the query." };
  return {
    kind: "page",
    source: "website",
    trust: "untrusted",
    target: tab.target,
    documentEpoch: tab.documentEpoch,
    url: tab.url,
    data,
  };
}
async function readOrWait(
  debuggee: chrome.debugger.Debuggee,
  request: ExtraRequest,
  revalidate: () => Promise<void>,
): Promise<unknown> {
  const step = request.step;
  if (step.op === "read")
    return evaluate(
      debuggee,
      `(${extract.toString()})(${JSON.stringify(step.selector)},${step.limit},${step.textLimit},${JSON.stringify(step.attributes)})`,
    );
  if (step.op !== "wait") throw new Error("UNSUPPORTED");
  const deadline = Date.now() + step.timeoutMs;
  while (Date.now() < deadline) {
    await revalidate();
    const found = await evaluate(
      debuggee,
      `Boolean(document.querySelector(${JSON.stringify(step.selector)}))`,
    );
    if (found) return { found: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { found: false, timedOut: true };
}
function extract(
  selector: string,
  limit: number,
  textLimit: number,
  attributes: string[],
): unknown {
  const elements = document.querySelectorAll(selector);
  return {
    count: elements.length,
    truncated: elements.length > limit,
    items: [...elements].slice(0, limit).map((element) => ({
      text: (element.textContent ?? "").trim().slice(0, textLimit),
      attributes: Object.fromEntries(
        attributes.map((attribute) => [
          attribute,
          element.getAttribute(attribute)?.slice(0, textLimit) ?? null,
        ]),
      ),
    })),
  };
}
async function evaluate(debuggee: chrome.debugger.Debuggee, expression: string): Promise<unknown> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (result.exceptionDetails) throw new Error("INVALID_TARGET");
  return result.result?.value;
}
