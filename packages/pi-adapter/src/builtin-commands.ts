import type { PiSlashCommand } from "@pippin/domain";

// Read the pinned Pi SDK's canonical catalog, which its root API does not export.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const catalog = (await import(new URL("./core/slash-commands.js", sdkEntry).href)) as {
  BUILTIN_SLASH_COMMANDS: readonly { name: string; description: string; argumentHint?: string }[];
};
export function builtinCommands(): PiSlashCommand[] {
  return catalog.BUILTIN_SLASH_COMMANDS.map((command) => ({
    kind: "builtin",
    name: command.name,
    invocation: "/" + command.name,
    description: command.description,
    argumentHint: command.argumentHint ?? null,
  }));
}
