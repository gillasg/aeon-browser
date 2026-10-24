import { blockedSitesKey } from "@aeon/ui";
import type { DaemonUiResponse } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";

// Blocked sites now live in browserkit's site-rules.json, behind the daemon. Home reads and
// changes that one list; the first read carries the extension's old localStorage list so it is
// migrated. The extension's chrome.storage copy follows every answer for the engine's checks.

export class HomeBlockedSites {
  sites: string[] = [];
  private loaded = false;

  constructor(
    private readonly options: {
      client(): UiClient | undefined;
      onChange(): void;
      onError(message: string): void;
    },
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.send({ action: "read", local: readLocal() });
  }

  async add(site: string): Promise<void> {
    await this.send({ action: "add", site });
  }

  async remove(site: string): Promise<void> {
    await this.send({ action: "remove", site });
  }

  private async send(payload: {
    action: "read" | "add" | "remove";
    site?: string;
    local?: string[];
  }): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: "settings.blocked-sites",
        payload,
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (
        response.kind !== "command.completed" ||
        response.result.kind !== "settings.blocked-sites"
      )
        throw new Error("Unexpected blocked-sites answer.");
      this.sites = response.result.sites;
      persist(this.sites);
      this.options.onChange();
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }
}

function readLocal(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(blockedSitesKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function persist(sites: string[]): void {
  try {
    localStorage.setItem(blockedSitesKey, JSON.stringify(sites));
    window.dispatchEvent(new Event(blockedSitesKey));
  } catch {
    // Storage may be unavailable.
  }
  void chrome.storage.local.set({ "blocked-sites": sites }).catch(() => undefined);
}

function isCommandResponse(
  message: DaemonUiResponse,
  requestId: string,
): message is Extract<DaemonUiResponse, { kind: "command.completed" | "command.failed" }> {
  return (
    (message.kind === "command.completed" || message.kind === "command.failed") &&
    message.requestId === requestId
  );
}
