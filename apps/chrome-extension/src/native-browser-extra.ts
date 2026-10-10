import { selectorState } from "./native-browser-selector-state.js";
import { BrowserActionError } from "./native-browser-errors.js";
import { focusNode, pressKey } from "./native-browser-input.js";
import { prepareElement } from "./native-browser-prepare.js";
import type { BrowserExecutorRequest, BrowserExecutorResult } from "@pippin/protocol";
import { withBrowserDebugger, assertRequestActive } from "./native-browser-session.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { readDiagnostics } from "./native-browser-events.js";
import { navigateReady } from "./native-browser-navigation.js";
import { executeSiteScript } from "./site-script-runtime.js";
import { sameTarget, safePage } from "./native-browser-common.js";
import { browserPopups } from "./native-browser-popup.js";
import { executePageCode } from "./native-browser-code.js";
import { primeBrowserSettle, settleBrowserPage } from "./native-browser-settle.js";
import { isFocusedInput } from "./native-browser-text.js";
type ExtraRequest = BrowserExecutorRequest & {
  step: Extract<
    BrowserExecutorRequest["step"],
    {
      op:
        | "press"
        | "read"
        | "wait"
        | "navigate"
        | "diagnostics"
        | "siteScript"
        | "popups"
        | "evaluate"
        | "cdp"
        | "waitFor";
    }
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
      if (
        request.step.op === "evaluate" ||
        request.step.op === "cdp" ||
        request.step.op === "waitFor"
      )
        return executePageCode(debuggee, { ...request, step: request.step }, () =>
          revalidate(request, tabId),
        );
      if (request.step.op === "press")
        return pressElement(debuggee, request, () => revalidate(request, tabId));
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
  if (encoded && encoded.length > 1_000_000)
    throw new BrowserActionError(
      "UNSUPPORTED",
      "Result exceeds 1 MB; extract in smaller batches and save artifacts.",
    );
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
      `(${selectorState.toString()})(${JSON.stringify(step.selector)},${JSON.stringify(step.state)})`,
    );
    if (found) return { found: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new BrowserActionError(
    "TIMEOUT",
    `Selector ${JSON.stringify(step.selector)} did not become ${step.state} within ${step.timeoutMs}ms. Inspect the page or use another selector.`,
  );
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
      text: ((element as HTMLElement).innerText ?? element.textContent ?? "")
        .trim()
        .slice(0, textLimit),
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

async function pressElement(
  debuggee: chrome.debugger.Debuggee,
  request: ExtraRequest,
  revalidate: () => Promise<void>,
) {
  if (request.step.op !== "press") throw new Error("INVALID_TARGET");
  if (request.step.focus === false) {
    const element = request.step.element;
    if (element.kind === "backend" && element.documentEpoch !== request.expectedDocumentEpoch)
      throw new Error("STALE_REF");
    if (!(await isFocusedInput(debuggee))) throw new Error("NOT_EDITABLE");
  } else {
    const { node } = await prepareElement(debuggee, request, request.step.element, revalidate);
    await focusNode(debuggee, node.backendNodeId);
  }
  await primeBrowserSettle(debuggee);
  await revalidate();
  await pressKey(debuggee, request.step.key);
  return { pressed: request.step.key, settle: await settleBrowserPage(debuggee) };
}
