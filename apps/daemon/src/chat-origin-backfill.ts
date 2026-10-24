import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatRecord, ChatStore } from "@aeon/domain";

// What earlier chats came from, once. Only clear evidence is used, never a guess: an agent's
// thread tool created the chat, a CLI run's report names it, or its first message carried page
// context from the composer. Everything else stays unknown.

export interface OriginBackfillCounts {
  cli: number;
  agent: number;
  user: number;
}

const MAX_HEAD_ENTRIES = 40;
const COMPOSER_CONTEXT = "pippin.browser-context.v1";

export async function backfillChatOrigins(
  store: ChatStore,
  dataDirectory: string,
): Promise<OriginBackfillCounts> {
  const cli = await cliChatIds(dataDirectory);
  const agent = new Set(store.listAgentCreatedChatIds());
  const counts: OriginBackfillCounts = { cli: 0, agent: 0, user: 0 };
  for (const chat of store.listAllChats()) {
    if (chat.origin !== "unknown") continue;
    const origin = await originOf(chat, agent, cli);
    if (origin && store.setChatOriginIfUnknown(chat.chatId, origin)) counts[origin] += 1;
  }
  return counts;
}

async function originOf(
  chat: ChatRecord,
  agent: ReadonlySet<string>,
  cli: ReadonlySet<string>,
): Promise<"agent" | "cli" | "user" | undefined> {
  if (agent.has(chat.chatId)) return "agent";
  if (cli.has(chat.chatId)) return "cli";
  if (await composerChat(chat.piReference?.sessionFile)) return "user";
  return undefined;
}

/** Chat ids a CLI run wrote into data/cli-runs. */
async function cliChatIds(dataDirectory: string): Promise<Set<string>> {
  const folder = join(dataDirectory, "cli-runs");
  const ids = new Set<string>();
  for (const file of await readdir(folder).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    try {
      const runs = JSON.parse(await readFile(join(folder, file), "utf8")) as {
        chatId?: unknown;
      }[];
      for (const run of runs) if (typeof run.chatId === "string") ids.add(run.chatId);
    } catch {
      // A half-written report is not evidence.
    }
  }
  return ids;
}

/** Whether the session's first message came with page context, as the composer sends it. */
async function composerChat(file: string | undefined): Promise<boolean> {
  if (!file) return false;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n", MAX_HEAD_ENTRIES)) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; customType?: unknown; message?: { role?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === COMPOSER_CONTEXT) return true;
    if (entry.type === "message" && entry.message?.role === "assistant") return false;
  }
  return false;
}
