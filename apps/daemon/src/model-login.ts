import { randomUUID } from "node:crypto";
import type { LoginServer } from "./model-accounts/server.js";

// The sign-in service behind Graft's Models page: every provider Pi supports. Graft's page talks to
// it on 127.0.0.1 with the token in the returned address and opens providers' sign-in pages as
// Chrome tabs itself. Logins land in Pi's own auth.json, so chats, the Pi CLI and other Pi apps
// all see them.
const IDLE_CLOSE_MS = 30 * 60_000;
let active: { server: LoginServer; agentDir: string | undefined } | undefined;
/** Everyone who asked for the service hears every change, not only the first caller. */
const listeners = new Set<() => void>();

/** Starts (or reuses) the sign-in service and returns its address. `onChange` runs after each sign-in or sign-out. */
export async function openModelLogin(
  agentDir: string | undefined,
  onChange: () => void,
): Promise<string> {
  listeners.add(onChange);
  if (active && active.agentDir === agentDir) return active.server.url;
  // Another agent directory (a test, a profile switch): its logins live elsewhere, so start over.
  if (active) await closeActive(active.server);
  // Loaded on first use: the provider SDKs are only needed while signing in.
  const { startLoginServer } = await import("./model-accounts/server.js");
  const server = await startLoginServer(agentDir ? { agentDir } : {});
  active = { server, agentDir };
  server.service.on("change", () => {
    for (const listener of listeners) listener();
  });
  const timer = setTimeout(() => void closeActive(server), IDLE_CLOSE_MS);
  timer.unref();
  const close = () => {
    clearTimeout(timer);
    void closeActive(server);
  };
  server.events.once("done", close).once("closed", close);
  return server.url;
}

async function closeActive(server: LoginServer): Promise<void> {
  if (active?.server !== server) return;
  active = undefined;
  await server.close();
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
  const { defaultModel } = await import("./model-accounts/model.js");
  const handle = await defaultModel(agentDir ? { agentDir } : {});
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
