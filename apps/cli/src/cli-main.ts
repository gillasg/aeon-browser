import { exitAfterFlush } from "./exit.js";
import { readFileSync } from "node:fs";
import { closeSharedBridge as closeCrawlBridge } from "@browserkit/tools/browser-crawl";
import { closeSharedBridge, errorKind } from "@browserkit/tools/site-to-api";
import { has, parseArgs } from "browserkit/dist/args.js";
import { out, printError } from "browserkit/dist/output.js";
import { commandHelp, usageText, type Command } from "browserkit/dist/usage.js";
import { graftCommands } from "./commands.js";
import { DaemonHost, installGraftCliHost } from "./host.js";

// The full command line: the chat commands, and everything browserkit's command line can do, through Graft's daemon
// and the user's own Chrome. Exit codes match browserkit's: 2 needs input, 3 signed out, 4 no
// browser, 5 the API failed, 6 a bot wall answered.

const EXIT_CODES: Record<string, number> = {
  failed: 1,
  "missing-input": 2,
  "signed-out": 3,
  "browser-offline": 4,
  broken: 5,
  challenged: 6,
};

const HELP = new Set(["help", "--help", "-h"]);
const VERSION = new Set(["version", "--version", "-v", "-V"]);

function printVersion(): number {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version?: string;
  };
  out(`graft ${manifest.version ?? "unknown"}`);
  return 0;
}
const host = new DaemonHost();

async function main(argv: string[]): Promise<number> {
  await installGraftCliHost(host);
  const commands = graftCommands(host);
  if (VERSION.has(argv[0] ?? "")) return printVersion();
  if (HELP.has(argv[0] ?? "")) return printHelp(commands, argv.slice(1));
  const args = parseArgs(argv);
  const [name, ...rest] = args.positional;
  if (!name) {
    out(usageText(commands, "graft"));
    return 0;
  }
  const command = commands.find((item) => item.name === name);
  if (!command) {
    out(usageText(commands, "graft"));
    return 1;
  }
  if (has(args, "help")) {
    out(commandHelp(command, "graft"));
    return 0;
  }
  // `--browser <name>` works on every command that reaches Chrome (boosts, map, cookies, record
  // and browserkit's own), not only the ones that read it: with two Chromes connected, a command
  // without it used to fail as ambiguous or land in the wrong profile.
  const browser = args.flags.browser;
  if (typeof browser === "string") host.pinBrowser(browser);
  return command.run({ ...args, positional: rest });
}

function printHelp(commands: Command[], rest: string[]): number {
  const name = rest[0];
  const command = name ? commands.find((item) => item.name === name) : undefined;
  out(command ? commandHelp(command, "graft") : usageText(commands, "graft"));
  return command || !name ? 0 : 1;
}

async function close(): Promise<void> {
  host.close();
  await Promise.all([closeSharedBridge(), closeCrawlBridge()]);
}

main(process.argv.slice(2)).then(
  async (code) => {
    await close();
    await exitAfterFlush(code);
  },
  async (error: unknown) => {
    // Errors come from browserkit's commands too; in Graft they must not name another product.
    const renamed =
      error instanceof Error ? new Error(error.message.replace(/\bbrowserkit\b/g, "graft")) : error;
    if (process.argv.includes("--json")) {
      out(
        JSON.stringify({
          ok: false,
          error: {
            message: renamed instanceof Error ? renamed.message : String(renamed),
            kind: errorKind(error),
          },
        }),
      );
    } else {
      printError(renamed);
    }
    await close();
    await exitAfterFlush(EXIT_CODES[errorKind(error)] ?? 1);
  },
);
