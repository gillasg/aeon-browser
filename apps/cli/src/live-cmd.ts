import { flag, has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import type { DaemonHost } from "./host.js";

// `graft live`: a page on this machine that rows and frames stream into while you watch it.
// The viewer runs in the daemon and closes when Graft stops (or after 2 hours unused).

export const LIVE_HELP = `Usage: graft live start [--title <text>] [--json]
       graft live list [--json]
       graft live stop <id>

Opens a live viewer: open its url in Chrome, then push rows or frames to it:
  curl -X POST <pushUrl> -H "authorization: Bearer <token>" -d '{"rows":[{"a":1}]}'
  curl -X POST <pushUrl> -H "authorization: Bearer <token>" -d '{"frame":{"tick":1}}'
Boosts push with GM.liveView.push(rows | frame) and never see the token; browser code uses
browser.liveView.start/list/stop. Viewers close when Graft stops and after 2 hours unused.`;

type Json = Record<string, unknown>;

const line = (view: Json): string =>
  `${String(view.id)}  ${String(view.title ?? "")}  ${String(view.rows ?? 0)} rows, ${String(view.frames ?? 0)} frames  ${String(view.url)}`;

async function runLive(host: DaemonHost, args: Args): Promise<number> {
  const [action, id] = args.positional;
  const client = await host.connect();
  const json = has(args, "json");
  if (action === "start") {
    const title = flag(args, "title");
    const view = (await client.live({ liveView: "start", ...(title ? { title } : {}) })) as Json;
    if (json) process.stdout.write(JSON.stringify(view, null, 2) + "\n");
    else
      process.stdout.write(
        `Live viewer ${String(view.id)}: open ${String(view.url)}\npush: ${String(view.pushUrl)}\ntoken: ${String(view.token)}\n`,
      );
    return 0;
  }
  if (action === "list") {
    const views = ((await client.live({ liveView: "list" })) as Json[]) ?? [];
    if (json) process.stdout.write(JSON.stringify(views, null, 2) + "\n");
    else
      process.stdout.write(views.length ? views.map(line).join("\n") + "\n" : "No live viewers.\n");
    return 0;
  }
  if (action === "stop" && id) {
    const answer = (await client.live({ liveView: "stop", id })) as Json;
    process.stdout.write(answer.stopped ? `Stopped ${id}.\n` : `No live viewer ${id}.\n`);
    return answer.stopped ? 0 : 1;
  }
  process.stderr.write(LIVE_HELP + "\n");
  return 2;
}

export function liveCommand(host: DaemonHost): Command {
  return {
    name: "live",
    group: "Browser",
    summary: "Start, list or stop a live viewer that rows and frames stream into",
    help: LIVE_HELP,
    run: (args) => runLive(host, args),
  };
}
