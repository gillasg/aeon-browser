// The scanline join (`align` step): which page value and which terminal row are the same fact.
// Provenance first (page.why's `provenance` beats carry the JSON path and the element's bounds),
// then an exact text match. The kit lines the two up; `aligned: false` fails the house lint.
import type { Box, RecordingEvents, VideoEvent } from "./record-events.js";

export type Alignment = {
  text: string;
  via: "provenance" | "text" | "none";
  aligned: boolean;
  box?: Box;
  jsonPath?: string;
  line?: number;
};

// eslint-free escape match: ESC is built from its code so the pattern has no control literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Terminal rows as the kit draws them: the command, then output split on newlines. */
export function castLines(recording: RecordingEvents | undefined): string[] {
  const events = recording?.terminal?.events ?? [];
  return events.flatMap((e) =>
    e.kind === "in" ? [`$ ${e.text}`] : e.text.replace(ANSI, "").split(/\r?\n/).filter(Boolean),
  );
}

const lineOf = (lines: string[], needle: string) => {
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i : undefined;
};

function provenanceFor(events: VideoEvent[], text: string): VideoEvent | undefined {
  return events.find((e) => e.beat === "provenance" && e.box && (e.text === text || !e.text));
}

const withLine = (line: number | undefined) => (line !== undefined ? { line } : {});

function viaProvenance(
  prov: VideoEvent,
  box: Box,
  text: string,
  lines: string[],
  line?: number,
): Alignment {
  const leaf = prov.jsonPath
    ?.split(/[.[\]]/)
    .filter(Boolean)
    .pop();
  const row = line ?? lineOf(lines, text) ?? (leaf ? lineOf(lines, `"${leaf}"`) : undefined);
  return {
    text,
    via: "provenance",
    aligned: row !== undefined,
    box,
    ...(prov.jsonPath ? { jsonPath: prov.jsonPath } : {}),
    ...withLine(row),
  };
}

/** Join `text` on the page to a terminal row; `pageBox` is a live exact-text lookup, if any. */
export function align(
  recording: RecordingEvents | undefined,
  text: string,
  line?: number,
  pageBox?: Box,
): Alignment {
  const lines = castLines(recording);
  const prov = provenanceFor(recording?.events ?? [], text);
  if (prov?.box) return viaProvenance(prov, prov.box, text, lines, line);
  const box = pageBox ?? recording?.events.find((e) => e.text === text && e.box)?.box;
  const row = line ?? lineOf(lines, text);
  if (!box) return { text, via: "none", aligned: false, ...withLine(row) };
  return { text, via: "text", aligned: row !== undefined, box, ...withLine(row) };
}

/** The recording with its `align` filled, or undefined when there is no log yet. */
export function alignInto(
  recording: RecordingEvents | undefined,
  text: string,
  line?: number,
  pageBox?: Box,
): RecordingEvents | undefined {
  if (!recording) return undefined;
  return { ...recording, align: align(recording, text, line, pageBox) };
}
