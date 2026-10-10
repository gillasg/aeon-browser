import type { BrowserStep } from "@pippin/protocol";
export function requiresBrowserRuntime(step: BrowserStep): boolean {
  if (
    [
      "evaluate",
      "cdp",
      "waitFor",
      "event",
      "frames",
      "upload",
      "downloads",
      "pointer",
      "keys",
      "reconnect",
    ].includes(step.op)
  )
    return true;
  if ("observe" in step && step.observe !== undefined) return true;
  if ("focus" in step && step.focus !== undefined) return true;
  return "element" in step && step.element?.kind === "backend";
}
export function requiresBrowserActions(step: BrowserStep): boolean {
  if (["press", "wait", "waitFor", "evaluate", "cdp"].includes(step.op)) return true;
  if (step.op === "observe") return Boolean(step.query || step.interactive || step.selector);
  if (!("element" in step) || !step.element) return false;
  const element = step.element;
  return (
    element.kind === "query" ||
    element.kind === "backend" ||
    (element.kind === "locator" && (element.exact !== undefined || element.scope !== undefined))
  );
}
