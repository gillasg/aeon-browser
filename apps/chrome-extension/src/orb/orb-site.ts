import { askCore } from "../companion-requests.js";

// The worker's side of what the orb and pages know about a site, all answered by core with no
// model: the operations a site learned (the orb's chips) and saved reads (what changed on a page
// since Aeon last read it, and moving that baseline to what the user just saw).

export interface SiteOperation {
  id: string;
  what?: string;
  writes?: boolean;
  sentBy?: string;
}

export interface SavedReadReply {
  url: string;
  at: string;
  lines: string[];
}

type SiteMessage =
  | { kind: "aeon.site.operations"; host: string }
  | { kind: "aeon.site.undo"; site: string; operation: string; params?: Record<string, unknown> }
  | { kind: "aeon.page.saved"; url: string }
  | { kind: "aeon.page.seen"; url: string; text: string };

function isSiteMessage(value: unknown): value is SiteMessage {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return (
    kind === "aeon.site.operations" ||
    kind === "aeon.site.undo" ||
    kind === "aeon.page.saved" ||
    kind === "aeon.page.seen"
  );
}

function answer(message: SiteMessage): Promise<unknown> {
  if (message.kind === "aeon.site.operations")
    return askCore("site", { action: "operations", site: message.host });
  if (message.kind === "aeon.site.undo")
    return askCore("site", {
      action: "undo",
      site: message.site,
      operation: message.operation,
      params: message.params ?? {},
    });
  if (message.kind === "aeon.page.saved")
    return askCore("site", { action: "read.get", url: message.url });
  return askCore("site", {
    action: "read.seen",
    url: message.url,
    text: message.text.slice(0, 400_000),
  });
}

export function installSiteAnswers(): void {
  chrome.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
    if (!isSiteMessage(request) || sender.id !== chrome.runtime.id) return;
    // Pages only ask about themselves; the orb and Activity (extension pages) ask for their site.
    const extensionPage =
      request.kind === "aeon.site.operations" || request.kind === "aeon.site.undo";
    const tabUrl = sender.tab?.url;
    if (!extensionPage && (!tabUrl || pageKey(tabUrl) !== pageKey(request.url))) return;
    void answer(request).then(sendResponse, () => sendResponse(null));
    return true;
  });
}

/** A page address without its fragment, matching how saved reads are keyed. */
function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}
