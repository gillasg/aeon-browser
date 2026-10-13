import type { DaemonUiResponse } from "@aeon/protocol";
import type { ModelLoginState } from "@aeon/ui";

// "Connect a model": core opens Pi's sign-in page, the user signs in in a new tab, and the page
// that asked watches for the new models: right away when the user comes back, and every few
// seconds meanwhile. No terminal, no restart.
const POLL_MS = 2500;
const GIVE_UP_MS = 20 * 60_000;

export class ModelSignIn {
  state: ModelLoginState = { waiting: false };
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;

  constructor(
    private readonly command: (request: Record<string, unknown>) => Promise<DaemonUiResponse>,
    /** Reloads the models; resolves true once at least one is available. */
    private readonly refresh: () => Promise<boolean>,
    private readonly onChange: () => void,
  ) {
    const check = () => {
      if (this.state.waiting && document.visibilityState === "visible") void this.check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
  }

  async open(): Promise<void> {
    try {
      const response = await this.command({ operation: "chat.model-login", payload: {} });
      if (response.kind !== "command.completed" || response.result.kind !== "chat.model-login")
        throw new Error("Aeon could not open the sign-in page.");
      await chrome.tabs.create({ url: response.result.url });
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
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    const connected = await this.refresh().catch(() => false);
    if (!connected && Date.now() - this.startedAt < GIVE_UP_MS) return;
    this.dispose();
    this.state = { waiting: false };
    this.onChange();
  }
}
