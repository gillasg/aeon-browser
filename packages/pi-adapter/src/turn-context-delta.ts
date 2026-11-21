// The hidden context before each user message, sent as a delta. The first message of a session
// carries every line; a follow-up carries [now] and only the lines (and page banners) that changed
// since the last one, so an unchanged tab, ability list or attached page costs nothing again.
// Every REFRESH_EVERY messages the whole block goes out again, so a compacted history never
// leaves the model without it for long.

const REFRESH_EVERY = 6;
const ALWAYS = new Set(["now"]);

type Memory = { blocks: Map<string, string>; banners: string; sinceFull: number };

const memories = new WeakMap<object, Memory>();

/** Splits "[tag] value" lines into blocks; a block runs until the next tag line. */
export function contextBlocks(context: string): [string, string][] {
  const blocks: [string, string][] = [];
  for (const line of context.split("\n")) {
    const tag = /^\[([a-z]+)\] /.exec(line)?.[1];
    const last = blocks.at(-1);
    if (tag) blocks.push([tag, line]);
    else if (last) last[1] += `\n${line}`;
  }
  return blocks;
}

/** What to send this turn for `owner` (a session), and remember it as sent. */
export function turnContextDelta(owner: object, context: string, banners: string[]): string {
  const blocks = contextBlocks(context);
  const banner = banners.join("\n\n");
  const memory = memories.get(owner);
  const full = !memory || memory.sinceFull + 1 >= REFRESH_EVERY;
  const kept = full
    ? blocks
    : blocks.filter(([tag, text]) => ALWAYS.has(tag) || memory.blocks.get(tag) !== text);
  const sendBanner = full || banner !== memory.banners;
  memories.set(owner, {
    blocks: new Map(blocks),
    banners: banner,
    sinceFull: full ? 0 : memory.sinceFull + 1,
  });
  return [kept.map(([, text]) => text).join("\n"), sendBanner ? banner : ""]
    .filter((part) => part.trim())
    .join("\n\n");
}
