// Build step: every `graft --help` text, written to dist/help.json, so help prints without
// loading the command line (that import alone took 3–5 s). Run by the build after tsc.
import { writeFileSync } from "node:fs";
import { commandHelp, usageText } from "browserkit/dist/usage.js";
import { graftCommands } from "./commands.js";
import { DaemonHost } from "./host.js";
import { HELP_FILE, type HelpIndex } from "./help-fast.js";

const commands = graftCommands(new DaemonHost());
const index: HelpIndex = {
  usage: usageText(commands, "graft"),
  commands: Object.fromEntries(
    commands.map((command) => [command.name, commandHelp(command, "graft")]),
  ),
};
writeFileSync(HELP_FILE, JSON.stringify(index));
process.exit(0);
