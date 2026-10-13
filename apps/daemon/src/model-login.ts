import type { LoginServer } from "pi-ai-login";

// The "Connect a model" page: every provider Pi supports, in the browser. Logins land in Pi's
// own auth.json, so chats, the Pi CLI and other Pi apps all see them.
const IDLE_CLOSE_MS = 30 * 60_000;
let active: LoginServer | undefined;

/** Starts (or reuses) the sign-in page and returns its address. `onChange` runs after each sign-in or sign-out. */
export async function openModelLogin(
  agentDir: string | undefined,
  onChange: () => void,
): Promise<string> {
  if (active) return active.url;
  // Loaded on first use: the provider SDKs are only needed while signing in.
  const { startLoginServer } = await import("pi-ai-login");
  const server = await startLoginServer(agentDir ? { agentDir, openSignInPages: true } : {});
  active = server;
  server.service.on("change", onChange);
  const close = () => {
    if (active !== server) return;
    active = undefined;
    clearTimeout(timer);
    void server.close();
  };
  const timer = setTimeout(close, IDLE_CLOSE_MS);
  timer.unref();
  server.events.once("done", close).once("closed", close);
  return server.url;
}
