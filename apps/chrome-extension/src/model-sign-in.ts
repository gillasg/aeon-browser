import type { ModelLoginState } from "@graft/ui";
import { modelsPageUrl, onModelsChanged } from "./model-broadcast.js";

// "Connect a model" / "Add or manage models…": opens Graft's Models page (Settings → Models) in a
// new tab that knows how to send the user back here, and this view picks up the new models the
// moment the page announces them, when the user comes back, or on a slow poll as a last resort.
// No terminal, no restart.
const POLL_MS = 2500;
const GIVE_UP_MS = 20 * 60_000;

export class ModelSignIn {
  state: ModelLoginState = { waiting: false };
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private readonly unsubscribe: () => void;

  constructor(
    /** Reloads the models; resolves true once at least one is available. */
    private readonly refresh: () => Promise<boolean>,
    private readonly onChange: () => void,
  ) {
    const check = () => {
      if (this.state.waiting && document.visibilityState === "visible") void this.check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    // Also when nothing is pending: a provider added from another view belongs in this picker.
    this.unsubscribe = onModelsChanged(() => void this.check());
  }

  async open(): Promise<void> {
    try {
      const here = await chrome.tabs.getCurrent().catch(() => undefined);
      const from = here?.id ?? (location.pathname.endsWith("sidepanel.html") ? "panel" : undefined);
      const url = modelsPageUrl(chrome.runtime.getURL("home.html"), from);
      await chrome.tabs.create({
        url,
        ...(here?.id !== undefined ? { openerTabId: here.id } : {}),
      });
      this.state = { waiting: true };
      this.startedAt = Date.now();
      if (!this.timer) this.timer = setInterval(() => void this.check(), POLL_MS);
    } catch (error) {
      this.state = {
        waiting: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.onChange();
  }

  dispose(): void {
    this.stopPolling();
    this.unsubscribe();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    const connected = await this.refresh().catch(() => false);
    if (!this.state.waiting) return this.onChange();
    if (!connected && Date.now() - this.startedAt < GIVE_UP_MS) return;
    this.stopPolling();
    this.state = { waiting: false };
    this.onChange();
  }
}
