// The `aeon film` command entry. The pipeline itself loads on first use (film-cmd.ts).
import type { Command } from "browserkit/dist/usage.js";
import type { DaemonHost } from "./host.js";

const FILM_USAGE = `Usage: aeon film [capture] <clip.json> [--out <dir>] [--kit <dir>] [--skip-qualify]
       [--stills 0,120] [--still-ms 0,2000] [--ffmpeg <bin>]
       aeon film render --kit <dir> --take <take dir> [--stills ...] [--still-ms ...] [--out <file>]`;

export function filmEntry(host: DaemonHost): Command {
  return {
    name: "film",
    group: "Aeon",
    summary:
      "shoot a raw take from one clip.json (frames, events, contact sheet); optionally render a kit",
    help: `${FILM_USAGE}

clip.json is a shoot plan ({"scenes": [...]}) plus "expect" (receipt text, maxSeconds).
The plan must have passed \`aeon record qualify <clip.json> --runs 3\` today, unless
--skip-qualify. Then: preflight (ffmpeg, disk) → shoot (clip.mp4 deferred) → contact.png
from the raw frames → take.json naming take/frames/ and take/events.json, ready for any editor.
With --kit (an \`aeon video kit\` dir), or \`aeon film render\`, the take is staged into the kit
and its src/Scene.tsx renders to film.mp4, or only PNG stills with --stills / --still-ms.`,
    run: async (args) =>
      (await import("./film-cmd.js")).filmCommand(host, { ...args, positional: args.positional }),
  };
}
