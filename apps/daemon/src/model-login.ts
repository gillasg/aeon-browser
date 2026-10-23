import { randomUUID } from "node:crypto";
import type { LoginServer } from "pi-ai-login";

// The sign-in service behind Aeon's Models page: every provider Pi supports. Aeon's page talks to
// it on 127.0.0.1 with the token in the returned address and opens providers' sign-in pages as
// Chrome tabs itself. Logins land in Pi's own auth.json, so chats, the Pi CLI and other Pi apps
// all see them.
const IDLE_CLOSE_MS = 30 * 60_000;
let active: LoginServer | undefined;

/** Starts (or reuses) the sign-in service and returns its address. `onChange` runs after each sign-in or sign-out. */
export async function openModelLogin(
  agentDir: string | undefined,
  onChange: () => void,
): Promise<string> {
  if (active) return active.url;
  // Loaded on first use: the provider SDKs are only needed while signing in.
  const { startLoginServer } = await import("pi-ai-login");
  const server = await startLoginServer({
    ...(agentDir ? { agentDir } : {}),
    openSignInPages: false,
  });
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

/**
 * One completion with the user's default model, for another extension that asked through the
 * browser extension. Earlier turns are folded into the request as a transcript.
 */
export async function modelComplete(
  agentDir: string | undefined,
  system: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const { getModel } = await import("pi-ai-login");
  const handle = await getModel(agentDir ? { agentDir } : {});
  const last = messages.at(-1)?.content ?? "";
  const earlier = messages
    .slice(0, -1)
    .map((message) => `${message.role === "assistant" ? "You" : "User"}: ${message.content}`)
    .join("\n\n");
  const content = earlier ? `Conversation so far:\n\n${earlier}\n\nNow:\n\n${last}` : last;
  const reply = await handle.models.completeSimple(
    handle.model,
    {
      systemPrompt: system,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    },
    { sessionId: randomUUID() },
  );
  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    throw new Error(
      `${handle.model.provider}/${handle.model.id}: ${reply.errorMessage ?? "the model failed"}`,
    );
  const text = reply.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error(`${handle.model.provider}/${handle.model.id} returned no text`);
  return text;
}
