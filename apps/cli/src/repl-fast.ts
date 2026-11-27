import { parseArgs } from "browserkit/dist/args.js";
import { out, printError } from "browserkit/dist/output.js";
import { errorKind } from "@browserkit/tools/site-to-api";
import { cellErrorMessage, runCellOn, type BrowserCell, type CellOptions } from "./cell-run.js";
import { GraftClient } from "./client.js";
import { repl } from "./repl.js";

// `graft repl` without the rest of the command line: only the daemon connection and the cell
// runner load, so each cell starts in a fraction of the full CLI's time. Agents run it in loops.

class LeanRunner {
  private client: Promise<GraftClient> | undefined;

  async runCell(code: string, options: CellOptions = {}): Promise<BrowserCell> {
    this.client ??= GraftClient.connect();
    const result = await runCellOn(await this.client, code, options);
    if (result.error)
      throw Object.assign(new Error(cellErrorMessage(result)), { output: result.output });
    return result;
  }

  async runInBrowser(code: string, options: CellOptions = {}): Promise<unknown> {
    return (await this.runCell(code, options)).value;
  }

  async close(): Promise<void> {
    if (this.client) (await this.client.catch(() => undefined))?.close();
  }
}

const SHORT_FLAGS: Record<string, string> = { "-q": "--quiet" };

/**
 * repl's arguments: flags work before or after the code (`graft repl "1+1" -q`), and `--` ends
 * them, so everything after it is code even when it looks like a flag.
 */
export function replArgs(argv: string[]): ReturnType<typeof parseArgs> {
  const stop = argv.indexOf("--");
  const head = (stop === -1 ? argv : argv.slice(0, stop)).map((arg) => SHORT_FLAGS[arg] ?? arg);
  const args = parseArgs(head);
  if (stop !== -1) args.positional.push(...argv.slice(stop + 1));
  return args;
}

export async function runRepl(argv: string[]): Promise<number> {
  const runner = new LeanRunner();
  try {
    const args = replArgs(argv);
    return await repl(runner, { ...args, positional: args.positional.slice(1) });
  } catch (error) {
    if (process.argv.includes("--json")) {
      out(
        JSON.stringify({
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            kind: errorKind(error),
          },
        }),
      );
    } else {
      printError(error);
    }
    return 1;
  } finally {
    await runner.close();
  }
}
