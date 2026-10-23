import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { NativeSettingsReplySchema, type AgentSettings } from "@aeon/protocol";

type SettingsChange = { [K in keyof AgentSettings]?: AgentSettings[K] | undefined };

// `aeon settings`: the agent settings live in the extension, so Core relays reads and changes to
// every connected Chrome. Screen recorders (Aperture) rely on this; keep it.
const waiting = new Map<string, (settings: AgentSettings) => void>();

export async function relayAgentSettings(
  sockets: WebSocket[],
  set: SettingsChange | undefined,
  timeoutMs = 5000,
): Promise<AgentSettings[]> {
  const open = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
  const replies = await Promise.all(open.map((socket) => ask(socket, set, timeoutMs)));
  return replies.filter((reply): reply is AgentSettings => reply !== undefined);
}

function ask(
  socket: WebSocket,
  set: SettingsChange | undefined,
  timeoutMs: number,
): Promise<AgentSettings | undefined> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      resolve(undefined);
    }, timeoutMs);
    waiting.set(requestId, (settings) => {
      clearTimeout(timer);
      waiting.delete(requestId);
      resolve(settings);
    });
    socket.send(JSON.stringify({ kind: "native.settings", requestId, ...(set ? { set } : {}) }));
  });
}

export function handleAgentSettingsReply(candidate: unknown): boolean {
  const reply = NativeSettingsReplySchema.safeParse(candidate);
  if (!reply.success) return false;
  waiting.get(reply.data.requestId)?.(reply.data.settings);
  return true;
}
