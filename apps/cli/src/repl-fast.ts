import { parseArgs } from "browserkit/dist/args.js";
import { printError } from "browserkit/dist/output.js";
import { cellErrorMessage, runCellOn, type BrowserCell, type CellOptions } from "./cell-run.js";
import { AeonClient } from "./client.js";
import { repl } from "./repl.js";

// `aeon repl` without the rest of the command line: only the daemon connection and the cell
// runner load, so each cell starts in a fraction of the full CLI's time. Agents run it in loops.

class LeanRunner {
  private client: Promise<AeonClient> | undefined;

  async runCell(code: string, options: CellOptions = {}): Promise<BrowserCell> {
    this.client ??= AeonClient.connect();
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

export async function runRepl(argv: string[]): Promise<number> {
  const runner = new LeanRunner();
  try {
    const args = parseArgs(argv);
    return await repl(runner, { ...args, positional: args.positional.slice(1) });
  } catch (error) {
    printError(error);
    return 1;
  } finally {
    await runner.close();
  }
}
