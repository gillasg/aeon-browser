import type { ChatViewSnapshot, PiSessionHandle } from "@aeon/domain";
export function boundedChatEntries(all: ChatViewSnapshot["entries"]): {
  entries: ChatViewSnapshot["entries"];
  omittedEntryCount: number;
} {
  let bytes = 0;
  let start = all.length;
  while (start > 0 && all.length - start < 250) {
    const size = Buffer.byteLength(JSON.stringify(all[start - 1]), "utf8") + 1;
    if (bytes + size > 700_000) break;
    bytes += size;
    start -= 1;
  }
  return { entries: all.slice(start), omittedEntryCount: start };
}

export interface ObservedSession {
  session: PiSessionHandle;
  unsubscribe(): void;
}
