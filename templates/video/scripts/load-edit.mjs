// Shared by the scripts: read events.json + director.json and build both director edits.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdit, DIRECTOR_CUT, DIRECTOR_SQUARE } from "../src/edit.ts";

export const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEdits(
  recordingPath = join(KIT, "src/recording.json"),
  directorPath = join(KIT, "src/director.json"),
) {
  const recording = JSON.parse(readFileSync(recordingPath, "utf8"));
  let script = {};
  try {
    script = JSON.parse(readFileSync(directorPath, "utf8"));
  } catch {
    // No director.json: the edit is derived from events.json alone.
  }
  return {
    recording,
    script,
    edits: {
      DirectorCut: buildEdit(recording, script, DIRECTOR_CUT),
      DirectorSquare: buildEdit(recording, script, DIRECTOR_SQUARE),
    },
  };
}
