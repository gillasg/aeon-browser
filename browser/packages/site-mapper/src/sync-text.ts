// Every function that runs synchronously on user-sized text, and the cap it will not pass.
// Above the cap the function returns a truncation note instead of scanning the rest.
// A 1 MB hostile input must finish within 200 ms (see test/sync-text.test.mjs).

export const TEXT_CAP = 262_144;

export interface SyncTextEntry {
  name: string;
  cap: number;
  module: string;
}

export const SYNC_TEXT: readonly SyncTextEntry[] = [
  { name: "redact.text", cap: TEXT_CAP, module: "browser/packages/site-mapper/src/redact.ts" },
  {
    name: "redactHarText",
    cap: TEXT_CAP,
    module: "browser/packages/engine/src/native-browser-network-format.ts",
  },
  { name: "toMarkdown", cap: TEXT_CAP, module: "browser/packages/crawl/src/content/html.ts" },
  { name: "diffLines", cap: TEXT_CAP, module: "browser/packages/boosts/src/shared/diff.ts" },
  {
    name: "inferSchema",
    cap: TEXT_CAP,
    module: "browser/packages/site-mapper/src/infer/schema.ts",
  },
  {
    name: "markdownReport",
    cap: TEXT_CAP,
    module: "browser/packages/site-mapper/src/emit/report.ts",
  },
];

export function truncationNote(name: string, length: number, cap = TEXT_CAP): string {
  return `[truncated ${length - cap} chars; ${name} cap ${cap}]`;
}
