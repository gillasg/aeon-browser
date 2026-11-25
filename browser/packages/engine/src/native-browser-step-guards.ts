import type { BrowserStep } from "@browserkit/protocol";

export function isPageAction(
  step: BrowserStep,
): step is Extract<BrowserStep, { op: "click" | "hold" | "fill" | "paste" | "scroll" }> {
  return ["click", "hold", "fill", "paste", "scroll"].includes(step.op);
}
export function isExtraStep(step: BrowserStep): step is Extract<
  BrowserStep,
  {
    op:
      | "press"
      | "read"
      | "wait"
      | "navigate"
      | "diagnostics"
      | "console"
      | "stealth"
      | "control"
      | "session"
      | "siteScript"
      | "popups"
      | "evaluate"
      | "cdp"
      | "readiness"
      | "settle"
      | "cookies"
      | "networkStore"
      | "scheduler"
      | "waitFor";
  }
> {
  return [
    "press",
    "read",
    "wait",
    "navigate",
    "diagnostics",
    "console",
    "stealth",
    "control",
    "session",
    "siteScript",
    "popups",
    "evaluate",
    "cdp",
    "readiness",
    "settle",
    "cookies",
    "networkStore",
    "scheduler",
    "waitFor",
  ].includes(step.op);
}
