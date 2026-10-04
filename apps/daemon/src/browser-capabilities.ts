import type { BrowserStep } from "@pippin/protocol";
export function requiresBrowserActions(step: BrowserStep): boolean {
  if (step.op === "press" || step.op === "wait") return true;
  if (step.op === "observe") return Boolean(step.query || step.interactive || step.selector);
  if (!("element" in step) || !step.element) return false;
  const element = step.element;
  return (
    element.kind === "query" ||
    (element.kind === "locator" && (element.exact !== undefined || element.scope !== undefined))
  );
}
