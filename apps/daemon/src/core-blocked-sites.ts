import { randomUUID } from "node:crypto";
import {
  CoreBlockedSitesRequestSchema,
  CoreBlockedSitesResultSchema,
  NativeBlockedSitesReplySchema,
  NativeBlockedSitesRequestSchema,
} from "@aeon/protocol";
import { WebSocket } from "ws";
import {
  addBlockedSite,
  readBlockedSites,
  removeBlockedSite,
  siteName,
} from "@browserkit/tools/host";
import type { BrowserControlService } from "./browser-control-service.js";
import { messageOf } from "./core-browser.js";

// `aeon block|unblock|blocked`: one list, in browserkit's home (site-rules.json), owned by this
// daemon. Changes are pushed to every connected Chrome so the engine's own chrome.storage
// fallback stays the same list. Only the user runs these commands; no chat tool reaches this.
// A site the user names in a request does not lift a block here: browserkit has no such lift.

export function handleBlockedSites(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
): boolean {
  const request = CoreBlockedSitesRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, action, site } = request.data;
  void apply(action, site).then(
    (sites) => {
      pushToExtensions(browser.executorSockets(), sites);
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify(
          CoreBlockedSitesResultSchema.parse({
            kind: "core.blocked-sites.result",
            requestId,
            sites,
          }),
        ),
      );
    },
    (error: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify(
          CoreBlockedSitesResultSchema.parse({
            kind: "core.blocked-sites.result",
            requestId,
            sites: [],
            error: messageOf(error),
          }),
        ),
      );
    },
  );
  return true;
}

async function apply(
  action: "read" | "add" | "remove",
  siteInput: string | undefined,
): Promise<string[]> {
  if (action === "read") return readBlockedSites();
  const site = siteName(siteInput ?? "");
  if (!site) throw new Error(`Not a site: ${siteInput ?? ""}`);
  const changed = action === "add" ? await addBlockedSite(site) : await removeBlockedSite(site);
  if (!changed) throw new Error(`Not a site: ${site}`);
  return readBlockedSites();
}

/** The extension's copy (chrome.storage) follows the file; the siteRules answer is the source. */
function pushToExtensions(sockets: WebSocket[], sites: string[]): void {
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    socket.send(
      JSON.stringify(
        NativeBlockedSitesRequestSchema.parse({
          kind: "native.blocked-sites",
          requestId: randomUUID(),
          action: "replace",
          sites,
        }),
      ),
    );
  }
}

/** The extension's answer to a replace; it carries nothing the daemon needs. */
export function handleBlockedSitesReply(candidate: unknown): boolean {
  return NativeBlockedSitesReplySchema.safeParse(candidate).success;
}
