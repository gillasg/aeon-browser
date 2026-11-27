import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  BrowserNotConnected,
  handleSiteMapperRequest,
  isSiteMapperRequest,
  useBrowser,
  type Bridge,
} from "@browserkit/tools/site-to-api";
import type { BrowserToolRunner } from "./browser-tool.js";
import { clampTimeoutMs, RewindSchema, type Rewind } from "@graft/protocol";
import { cellTimeoutMs } from "./run-budget.js";
import { createGraftHostHandler } from "./browser-host-requests.js";

// site-to-api and browser-crawl run small pieces of browser code in named sessions. In Graft they
// run in the user's Chrome through the same executor as browser_code: each (chat, session) pair
// gets its own runtime, so a crawl's parallel tabs and an API call never share variables with the
// agent's own browser_code cells.

const chats = new AsyncLocalStorage<{ chatId: string }>();
/** A crawl worker chat that must run in a named browser, set for the duration of bridge.run. */
const namedBrowser = new Map<string, string>();
const BACKGROUND = "graft-background";
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

function boundedCellTimeout(chatId: string, requested: number | undefined): number {
  const wanted = Math.min(Math.max(requested ?? 60_000, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const timeoutMs = clampTimeoutMs(cellTimeoutMs(chatId, wanted)).timeoutMs;
  if (timeoutMs <= 0)
    throw new Error("Not run: the time budget is spent. Answer with what you have.");
  return timeoutMs;
}

/** A stable UUID for a chat's named session (the executor keys runtimes by chat id). */
export function sessionChatId(chatId: string, session: string): string {
  const hex = createHash("sha256").update(`${chatId}\u0000${session}`).digest("hex");
  // Shaped as a version 5 UUID so the protocol's validation accepts it.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface CellOutput {
  error?: string;
  detail?: string;
  value?: unknown;
}

/** The chat whose browser pin a nested crawl call should copy. */
export function browserParentChat(): string | undefined {
  return chats.getStore()?.chatId;
}

/** The profile a worker chat was asked to use, while its cell is in flight. */
export function browserNamedFor(chatId: string): string | undefined {
  return namedBrowser.get(chatId);
}

export function graftBridge(run: BrowserToolRunner): Bridge {
  return {
    async run(code, options = {}) {
      const chatId = chats.getStore()?.chatId ?? BACKGROUND;
      const timeoutMs = boundedCellTimeout(chatId, options.timeoutMs);
      const child = sessionChatId(chatId, options.session ?? "default");
      const host = createGraftHostHandler({
        source: "external",
        siteMapper: (request) => siteMapperRequest(chatId, request),
      });
      if (options.browser) namedBrowser.set(child, options.browser);
      try {
        const output = await run(child, `site-${randomUUID()}`, {
          codeCell: {
            code,
            timeoutMs,
            ...(options.session?.startsWith("site-to-api")
              ? { ownerTitle: "Mapping" }
              : options.session === "browser-crawl-check"
                ? { ownerTitle: "Site check" }
                : {}),
            onCall: (request) =>
              host(request, {
                source: "external",
                scope: chatId,
                ...(options.browser ? { browser: options.browser } : {}),
              }) ?? Promise.resolve({ error: "UNSUPPORTED" }),
            onProgress: () => undefined,
          },
        });
        const cell = JSON.parse(output) as CellOutput;
        if (cell.error === "BROWSER_OFFLINE")
          throw new BrowserNotConnected("Graft's browser is not connected.");
        if (cell.error) throw new Error(cell.detail ? `${cell.error}: ${cell.detail}` : cell.error);
        return cell.value;
      } finally {
        namedBrowser.delete(child);
      }
    },
    status: () => Promise.resolve({ browsers: 1 }),
    close: () => undefined,
  };
}

/** Routes every site-to-api and browser-crawl browser call through Graft's executor. */
export function installGraftBrowser(run: BrowserToolRunner | undefined): void {
  if (run) useBrowser(graftBridge(run));
}

/** Runs tool work with browser calls attributed to this chat. */
export function inChat<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  return chats.run({ chatId }, work);
}

/** Browser code's siteMapper.call / watch requests (cells and watcher checks), run for this chat. */
export function siteMapperRequest(chatId: string, request: unknown): Promise<unknown> | undefined {
  if (!isSiteMapperRequest(request)) return undefined;
  return inChat(chatId, () => handleSiteMapperRequest(request));
}

/** How a write through a site's API can be taken back, or undefined when it cannot be. */
export async function siteRewind(
  chatId: string,
  site: string,
  operation: string,
): Promise<Rewind | undefined> {
  const found = await siteMapperRequest(chatId, { siteMapper: "rewind", site, operation });
  const parsed = RewindSchema.safeParse(found);
  return parsed.success ? parsed.data : undefined;
}
