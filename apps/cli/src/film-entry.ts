// The `aeon film` command entry. The pipeline itself loads on first use (film-cmd.ts).
import type { Command } from "browserkit/dist/usage.js";
import type { DaemonHost } from "./host.js";

export function filmEntry(host: DaemonHost): Command {
  return {
    name: "film",
    group: "Aeon",
    summary: "shoot, auto-edit, lint and render a launch film from one clip.json",
    help: `Usage: aeon film <clip.json> --kit <video-kit dir> [--out <dir>] [--ffmpeg <bin>]

clip.json is a shoot plan ({"scenes": [...]}) plus "expect" (receipt text, maxSeconds,
terminal text), an optional "end" {command, repo} and "targetMs". The plan must have
passed \`aeon record qualify <clip.json> --runs 3\` today. Then: preflight (kit, ffmpeg,
disk) → shoot (clip.mp4 deferred) → automatic edit from events.json → house lint →
1920x1080 render, film.json metadata and a contact sheet.`,
    run: async (args) =>
      (await import("./film-cmd.js")).filmCommand(host, { ...args, positional: args.positional }),
  };
}
