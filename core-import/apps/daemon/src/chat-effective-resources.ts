import { createHash } from "node:crypto";
import { PiSessionUnavailableError, type ChatId, type EffectivePiResources } from "@aeon/domain";
import type { ChatService } from "./chat-service.js";

export function readEffectiveResources(
  chats: Pick<ChatService, "getChat" | "withSession">,
  chatId: ChatId,
): Promise<EffectivePiResources> {
  const chat = chats.getChat(chatId);
  if (!chat) throw new Error(`Chat ${chatId} does not exist.`);
  if (chat.status === "draft") return Promise.resolve(emptyResources(chatId));
  if (chat.status === "failed" || chat.status === "unavailable")
    throw new PiSessionUnavailableError("This Chat's Pi session is unavailable.");
  return chats.withSession(chatId, (session) => session.effectiveResources());
}

function emptyResources(chatId: ChatId): EffectivePiResources {
  const empty = {
    chatId,
    sessionState: "not_started" as const,
    mcpServers: [],
    skills: [],
    extensions: [],
    extensionErrors: [],
    tools: [],
  };
  return { ...empty, revision: createHash("sha256").update(JSON.stringify(empty)).digest("hex") };
}
