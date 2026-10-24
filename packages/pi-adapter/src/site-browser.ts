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

// site-to-api and browser-crawl run small pieces of browser code in named sessions. In Aeon they
// run in the user's Chrome through the same executor as browser_code: each (chat, session) pair
// gets its own runtime, so a crawl's parallel tabs and an API call never share variables with the
// agent's own browser_code cells.

const chats = new AsyncLocalStorage<{ chatId: string }>();
const BACKGROUND = "aeon-background";
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

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

export function aeonBridge(run: BrowserToolRunner): Bridge {
  return {
    async run(code, options = {}) {
      const chatId = chats.getStore()?.chatId ?? BACKGROUND;
      const timeoutMs = Math.min(
        Math.max(options.timeoutMs ?? 60_000, MIN_TIMEOUT_MS),
        MAX_TIMEOUT_MS,
      );
      const output = await run(
        sessionChatId(chatId, options.session ?? "default"),
        `site-${randomUUID()}`,
        {
          codeCell: {
            code,
            timeoutMs,
            ...(options.session?.startsWith("site-to-api")
              ? { ownerTitle: "Mapping" }
              : options.session === "browser-crawl-check"
                ? { ownerTitle: "Site check" }
                : {}),
            onCall: () => Promise.resolve({ error: "UNSUPPORTED" }),
            onProgress: () => undefined,
          },
        },
      );
      const cell = JSON.parse(output) as CellOutput;
      if (cell.error === "BROWSER_OFFLINE")
        throw new BrowserNotConnected("Aeon's browser is not connected.");
      if (cell.error) throw new Error(cell.detail ? `${cell.error}: ${cell.detail}` : cell.error);
      return cell.value;
    },
    status: () => Promise.resolve({ browsers: 1 }),
    close: () => undefined,
  };
}

/** Routes every site-to-api and browser-crawl browser call through Aeon's executor. */
export function installAeonBrowser(run: BrowserToolRunner | undefined): void {
  if (run) useBrowser(aeonBridge(run));
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
