// `graft call|find|watch|status` take a lean path: agents call them in loops, and loading the whole
// command line (every command, the MCP server, the agent runtime) cost seconds per call. Each
// loads only the module that defines it; flags, help, output and exit codes match cli-main.ts.
import { has, parseArgs } from "browserkit/dist/args.js";
import { out, printError } from "browserkit/dist/output.js";
import { commandHelp, type Command } from "browserkit/dist/usage.js";
import { DaemonHost, installCliHostOnly, installGraftCliHost } from "./host.js";

const EXIT_CODES: Record<string, number> = {
  failed: 1,
  "missing-input": 2,
  "signed-out": 3,
  "browser-offline": 4,
  broken: 5,
  challenged: 6,
};

type Loader = (host: DaemonHost) => Promise<Command | undefined>;

// The same command objects cli-main.ts resolves for these names: `watch` and `status` are
// Graft's own (a chat, the daemon), `call` and `find` are browserkit's.
const LOADERS: Record<string, Loader> = {
  call: async () => (await import("browserkit/dist/commands/site-use.js")).callCommand,
  find: async () => (await import("browserkit/dist/commands/crawl.js")).findCommand,
  watch: async (host) =>
    (await import("./converse-commands.js"))
      .converseCommands(host)
      .find((command) => command.name === "watch"),
  status: async (host) =>
    (await import("./browser-commands.js"))
      .browserCommands(host)
      .find((command) => command.name === "status"),
};

const BRIDGED = new Set(["call", "find"]);

export const SITE_FAST_COMMANDS: ReadonlySet<string> = new Set(Object.keys(LOADERS));

/** The command `graft <name>` runs on the lean path, or undefined when it has none. */
export function siteFastCommand(name: string, host: DaemonHost): Promise<Command | undefined> {
  return LOADERS[name]?.(host) ?? Promise.resolve(undefined);
}

export async function runSiteFast(argv: string[]): Promise<number> {
  const host = new DaemonHost();
  try {
    if (BRIDGED.has(argv[0] ?? "")) await installGraftCliHost(host);
    else installCliHostOnly(host);
    const args = parseArgs(argv);
    const [name = "", ...rest] = args.positional;
    const command = await siteFastCommand(name, host);
    if (!command) throw new Error(`no lean command for ${name}`);
    if (has(args, "help")) {
      out(commandHelp(command, "graft"));
      return 0;
    }
    const browser = args.flags.browser;
    if (typeof browser === "string") host.pinBrowser(browser);
    return await command.run({ ...args, positional: rest });
  } catch (error) {
    return await reportError(error);
  } finally {
    host.close();
    // Only call and find load the site and crawl bridges; importing them just to close them
    // cost seconds on every `graft status`.
    if (BRIDGED.has(argv[0] ?? "")) await closeBridges();
  }
}

async function reportError(error: unknown): Promise<number> {
  const { errorKind } = await import("@browserkit/tools/site-to-api");
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
  return EXIT_CODES[errorKind(error)] ?? 1;
}

async function closeBridges(): Promise<void> {
  const [siteToApi, crawl] = await Promise.all([
    import("@browserkit/tools/site-to-api"),
    import("@browserkit/tools/browser-crawl"),
  ]);
  await Promise.all([siteToApi.closeSharedBridge(), crawl.closeSharedBridge()]);
}
