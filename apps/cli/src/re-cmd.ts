import { emitFromHar, type HarEmit } from "@browserkit/site-mapper";
import { flag, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";

// graft re har <file> --emit client|pack|mock: a saved HAR turned into a standalone typed client,
// a site pack, or a replay-only local mock server, with no browser and no network.

const USAGE =
  "Usage: graft re har <file.har> --emit client|pack|mock [--out path] [--site name] [--port n]";

async function runRe(args: Args): Promise<number> {
  const [what, file] = args.positional;
  const emit = flag(args, "emit");
  if (what !== "har" || !file || !["client", "pack", "mock"].includes(String(emit)))
    throw new Error(USAGE);
  const out = flag(args, "out");
  const site = flag(args, "site");
  const port = flag(args, "port");
  const result = await emitFromHar(file, {
    emit: emit as HarEmit,
    ...(out ? { out } : {}),
    ...(site ? { site } : {}),
    ...(port ? { port: Number(port) } : {}),
  });
  process.stdout.write(result.summary + "\n");
  for (const path of result.written) process.stdout.write(path + "\n");
  if (result.server) await new Promise(() => undefined);
  return 0;
}

export function reCommand(): Command {
  return {
    name: "re",
    group: "Use sites",
    summary: "turn a saved HAR into a typed client, a site pack or a local mock",
    help: `${USAGE}

client  writes client.ts (zero dependencies, plain fetch) and openapi.json to --out.
pack    imports the capture as a site and writes a site pack (.zip); its OpenAPI carries
        x-graft-observations, the per-field sample counts behind each schema.
mock    serves the recorded responses on 127.0.0.1 until stopped. Replay only: nothing is sent
        to the real site.`,
    run: runRe,
  };
}
