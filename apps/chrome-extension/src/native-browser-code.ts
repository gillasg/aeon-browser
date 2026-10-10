import type { BrowserExecutorRequest } from "@pippin/protocol";
import { BrowserActionError } from "./native-browser-errors.js";
import { primeBrowserSettle, settleBrowserPage } from "./native-browser-settle.js";

type Request = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "evaluate" | "cdp" | "waitFor" }>;
};
export async function executePageCode(
  debuggee: chrome.debugger.Debuggee,
  request: Request,
  revalidate: () => Promise<void>,
): Promise<unknown> {
  const step = request.step;
  if (step.op === "waitFor") {
    const start = Date.now();
    while (Date.now() - start < step.timeoutMs) {
      await revalidate();
      const value = await evaluatePage(
        debuggee,
        step.expression,
        Math.max(1, step.timeoutMs - (Date.now() - start)),
      );
      if (value) return { found: true, ms: Date.now() - start };
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new BrowserActionError(
      "TIMEOUT",
      "Page condition did not become true. Inspect the current state before proceeding.",
    );
  }
  const readOnly =
    step.op === "cdp" && /\.(get|describe|resolve|query|requestNode)/.test(step.method);
  if (!readOnly) await primeBrowserSettle(debuggee);
  let value: unknown;
  if (step.op === "evaluate") value = await evaluatePage(debuggee, step.expression, 8000);
  else {
    // This command operates on the claimed page session, never on a browser-wide or another target session.
    if (["Target", "Browser"].includes(step.method.split(".")[0] ?? ""))
      throw new BrowserActionError(
        "UNSUPPORTED",
        "Use browser.openTab/attachTab for target management; page.cdp addresses the selected page only.",
      );
    value = await chrome.debugger.sendCommand(debuggee, step.method, step.params);
  }
  return { value, ...(!readOnly ? { settle: await settleBrowserPage(debuggee) } : {}) };
}
async function evaluatePage(
  debuggee: chrome.debugger.Debuggee,
  expression: string,
  timeout: number,
) {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails)
    throw new BrowserActionError(
      "OPERATION_FAILED",
      (
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Page evaluation failed"
      ).slice(0, 1800),
    );
  return result.result?.value;
}
