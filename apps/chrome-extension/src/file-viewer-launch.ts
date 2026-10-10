import { z } from "zod";
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
  const url = new URL(chrome.runtime.getURL("viewer.html"));
  url.searchParams.set("chatId", chatId);
  url.searchParams.set("path", detail.path);
  if (detail.line) url.searchParams.set("line", String(detail.line));
  if (detail.original !== undefined && detail.modified !== undefined) {
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ ["aeon-viewer-" + id]: { ...detail, chatId } });
    url.searchParams.set("diff", id);
  }
  const existing = await chrome.tabs.query({});
  const tab = existing.find((candidate) => candidate.url === url.href);
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } else await chrome.tabs.create({ url: url.href });
}
