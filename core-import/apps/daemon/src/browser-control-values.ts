import { WebSocket } from "ws";
import type { BrowserExecutorResult, BrowserStep, BrowserTargetKey } from "@aeon/protocol";
import type { BrowserInventoryRegistry } from "./browser-inventory-registry.js";

export function listBrowserTabs(
  step: Extract<BrowserStep, { op: "listTabs" }>,
  executors: Map<string, WebSocket>,
  inventories?: BrowserInventoryRegistry,
): { result?: BrowserExecutorResult; code?: string } {
  if (![...executors.values()].some((socket) => socket.readyState === WebSocket.OPEN))
    return { code: "BROWSER_OFFLINE" };
  const tabs = [...executors.keys()].flatMap((clientId) => inventories?.get(clientId)?.tabs ?? []);
  const visible = tabs.filter(
    (tab) =>
      safeUrl(tab.url) &&
      (!step.query || `${tab.title} ${tab.url}`.toLowerCase().includes(step.query.toLowerCase())),
  );
  return { result: { kind: "tabs", tabs: visible.slice(0, 256) } };
}
export function safeUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export function normalizedUrl(value: string): string {
  return new URL(value).href;
}
export function targetIdentity(target: BrowserTargetKey): string {
  return `${target.clientInstanceId}/${target.browserRunId}/${target.tabId}/${target.tabIncarnation}`;
}
export function sameTarget(left: BrowserTargetKey, right: BrowserTargetKey): boolean {
  return targetIdentity(left) === targetIdentity(right);
}
