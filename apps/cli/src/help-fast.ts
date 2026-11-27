// `graft --help`, `graft -h`, `graft help <command>` and `graft <command> --help|-h` print from
// dist/help.json (written at build time by help-write.ts) instead of importing every command.
// A missing or older-than-the-build file falls back to the full command line, so help is never stale.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface HelpIndex {
  usage: string;
  commands: Record<string, string>;
}

export const HELP_FILE = fileURLToPath(new URL("./help.json", import.meta.url));
const DIST = fileURLToPath(new URL(".", import.meta.url));

function freshIndex(): HelpIndex | undefined {
  try {
    const written = statSync(HELP_FILE).mtimeMs;
    for (const file of readdirSync(DIST))
      if (file.endsWith(".js") && statSync(DIST + file).mtimeMs > written) return undefined;
    return JSON.parse(readFileSync(HELP_FILE, "utf8")) as HelpIndex;
  } catch {
    return undefined;
  }
}

const isHelp = (arg: string | undefined) => arg === "--help" || arg === "-h";

/** The help text for argv, or undefined when argv is not a help request this file can answer. */
export function helpText(argv: readonly string[], index = freshIndex()): string | undefined {
  if (!index) return undefined;
  if (argv[0] === "help" || isHelp(argv[0])) {
    const name = argv[1];
    if (!name || name.startsWith("-")) return index.usage;
    return index.commands[name];
  }
  const name = argv[0];
  if (!name || !argv.some(isHelp)) return undefined;
  return index.commands[name];
}
