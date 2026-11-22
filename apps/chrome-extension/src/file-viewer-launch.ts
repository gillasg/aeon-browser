import { z } from "zod";
import {
  pickViewerTab,
  pushRecent,
  readRecent,
  RECENT_KEY,
  viewerHref,
  type ViewerTarget,
} from "./viewer-files.js";
const Detail = z
  .object({
    path: z.string().min(1).max(4096),
    original: z.string().max(1_048_576).optional(),
    modified: z.string().max(1_048_576).optional(),
    label: z.string().max(100).optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();
export function installFileViewerLinks(chatId: string, currentPath?: () => string): void {
  window.addEventListener("aeon.open-file", (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = Detail.safeParse(event.detail);
    if (!detail.success) return;
    const value = detail.data;
    const base = currentPath?.();
    if (base && !/^(?:[a-z]:[\\/]|[\\/])/i.test(value.path))
      value.path = base.replace(/[\\/][^\\/]*$/, "") + "/" + value.path;
    void launch(chatId, value).catch((error: unknown) => {
      window.alert(error instanceof Error ? error.message : "Could not open the file viewer.");
    });
  });
}
async function launch(chatId: string, detail: z.infer<typeof Detail>): Promise<void> {
  let diff: string | undefined;
  if (detail.original !== undefined && detail.modified !== undefined) {
    diff = crypto.randomUUID();
    await chrome.storage.session.set({ ["aeon-viewer-" + diff]: { ...detail, chatId } });
  }
  const target = {
    chatId,
    path: detail.path,
    ...(detail.line ? { line: detail.line } : {}),
    ...(diff ? { diff } : {}),
  };
  await rememberRecent(target);
  const base = chrome.runtime.getURL("viewer.html");
  const href = viewerHref(base, target);
  const current = await chrome.windows.getCurrent().catch(() => undefined);
  // One Viewer tab: a click opens the file in it rather than in a new tab per file.
  const tab = pickViewerTab(await chrome.tabs.query({}), base, current?.id);
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { url: href, active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } else await chrome.tabs.create({ url: href });
}

/** Adds a file to the Viewer's recent strip (session storage, so it clears with the browser). */
export async function rememberRecent(target: ViewerTarget): Promise<void> {
  const stored = await chrome.storage.session.get(RECENT_KEY);
  await chrome.storage.session.set({
    [RECENT_KEY]: pushRecent(readRecent(stored[RECENT_KEY]), target, Date.now()),
  });
}
