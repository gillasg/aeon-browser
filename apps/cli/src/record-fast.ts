// `graft record start|stop|mark|wait|run|terminal|ui|shoot|assemble` take a lean path: a scripted recording calls
// them once per beat, and loading the whole command line cost seconds of dead air per call.
import { parseArgs } from "browserkit/dist/args.js";
import { DaemonHost } from "./host.js";
import { recordCommand } from "./record-cmd.js";

export async function runRecord(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const host = new DaemonHost();
  const browser = args.flags.browser;
  if (typeof browser === "string") host.pinBrowser(browser);
  try {
    return await recordCommand(undefined, host).run({
      ...args,
      positional: args.positional.slice(1),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    host.close();
  }
}
