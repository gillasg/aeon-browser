// Every open Aeon view (Home, chats, the side panel) hears about a sign-in, sign-out or default
// change the moment it happens, instead of waiting for its next look at the catalog.
const CHANNEL = "aeon-models";

export function announceModelsChanged(): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: "models-changed", at: Date.now() });
    channel.close();
  } catch {
    // No BroadcastChannel (tests, old runtimes): views still catch up when they get focus.
  }
}

/** Runs `listener` whenever another view announces a change. Returns the unsubscribe. */
export function onModelsChanged(listener: () => void): () => void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "models-changed") listener();
    };
    return () => channel.close();
  } catch {
    return () => undefined;
  }
}

/**
 * The Models page, remembering where the user came from: a tab id to go back to, or "panel"
 * when the side panel asked (it stays open beside the page).
 */
export function modelsPageUrl(base: string, from?: number | "panel"): string {
  const url = new URL(base);
  url.searchParams.set("view", "models");
  if (from !== undefined) url.searchParams.set("return", String(from));
  return url.href;
}

/** Where "Return to Aeon" goes, read back from the Models page address. */
export function returnTarget(href: string | undefined): number | "panel" | undefined {
  if (!href) return undefined;
  const value = new URL(href).searchParams.get("return");
  if (value === "panel") return value;
  const id = Number(value);
  return value && Number.isInteger(id) && id >= 0 ? id : undefined;
}
