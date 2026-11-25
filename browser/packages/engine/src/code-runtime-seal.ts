// Where the code runtime host seals and releases secrets (native-browser-seal.ts): every step and
// call answer is sealed on its way to agent code; every step or call that leaves for a site, or
// for an MCP server, is checked by the egress canary first.

import { currentInventoryTabs } from "./native-inventory-client.js";
import { vaultFor } from "./native-browser-seal.js";
import { scrubSecrets } from "./native-browser-secrets.js";

type Step = { op: string; target?: { tabId?: unknown }; url?: unknown; value?: unknown };

function tabUrl(step: Step): string | null {
  const tabId = step.target?.tabId;
  if (typeof tabId !== "number") return null;
  const tab = currentInventoryTabs().find((item) => item.target.tabId === tabId) as
    { url?: unknown } | undefined;
  return typeof tab?.url === "string" ? tab.url : null;
}

/** A step answer, passwords scrubbed, its cookies, auth headers and tokens sealed for the tab's site. */
export async function sealStepResult<T>(
  chatId: string,
  step: Step,
  result: Promise<T>,
): Promise<T> {
  return vaultFor(chatId).sealValue(await scrubSecrets(await result), tabUrl(step), step.op);
}

/** The step with same-site handles released; a secret bound for another site throws. */
export function releaseStep<T extends Step>(chatId: string, step: T): T {
  const vault = vaultFor(chatId);
  if (!vault.size) return step;
  if (step.op === "navigate" || step.op === "openTab") {
    const url = typeof step.url === "string" ? step.url : null;
    return { ...step, url: vault.release(step.url, url, "goto") };
  }
  if (step.op === "fill" || step.op === "paste") {
    const value = step.value ?? (step as { text?: unknown }).text;
    if (value === undefined) return step;
    const key = step.value !== undefined ? "value" : "text";
    return { ...step, [key]: vault.release(value, tabUrl(step), step.op) };
  }
  return step;
}

/** A host call (fetch, mcp.*) with the canary applied: fetch may replay same-site; MCP never. */
export function releaseCall(
  chatId: string,
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return value;
  const vault = vaultFor(chatId);
  const mcp = value.mcp as Record<string, unknown> | undefined;
  if (mcp && mcp.args !== undefined) {
    vault.release(mcp.args, null, `mcp.call ${String(mcp.server)}.${String(mcp.tool)}`);
    return value;
  }
  const fetch = value.fetch as Record<string, unknown> | undefined;
  if (fetch && vault.size) {
    const url = typeof fetch.url === "string" ? fetch.url : null;
    return { ...value, fetch: vault.release(fetch, url, "fetch") };
  }
  return value;
}

/** A host call answer sealed (a fetch answer for the site it came from). */
export async function sealCallResult<T>(
  chatId: string,
  value: Record<string, unknown> | null,
  out: T,
): Promise<T> {
  const fetch = value?.fetch as { url?: unknown } | undefined;
  const site = typeof fetch?.url === "string" ? fetch.url : null;
  // Nothing that reaches agent code carries a password, whatever answered it.
  return vaultFor(chatId).sealValue(await scrubSecrets(out), site);
}
