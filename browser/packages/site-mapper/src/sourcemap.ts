import { privateTarget } from "@browserkit/protocol";

// Source maps, read out of band: where a script names its map (the SourceMap or X-SourceMap
// response header first, then the sourceMappingURL comment), whether that URL is safe to follow,
// and a plain VLQ decoder that maps a generated {line, col} back to the original file and line.

export interface MapPosition {
  /** 1-based line in the generated file. */
  line: number;
  /** 0-based column in the generated file. */
  col: number;
}

export interface OriginalPosition {
  source: string;
  line: number;
  col: number;
  name?: string;
}

export interface DecodedMap {
  sources: string[];
  names: string[];
  /** One list per generated line, sorted by column: [genCol, source, line, col, name?]. */
  lines: number[][][];
  sourcesContent?: (string | null)[];
}

/** Where the map for a script lives: response headers first, then the trailing comment. */
export function discoverMapUrl(
  fileUrl: string,
  text: string,
  headers: Record<string, string> = {},
): string | undefined {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const named =
    lower["sourcemap"] ??
    lower["x-sourcemap"] ??
    /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(text.slice(-4_000))?.[1] ??
    /\/\/[#@]\s*sourceMappingURL=(\S+)/.exec(text)?.[1];
  if (!named || named.startsWith("data:")) return undefined;
  try {
    return new URL(named.trim(), fileUrl).href;
  } catch {
    return undefined;
  }
}

/**
 * Why a map URL must not be fetched, or undefined when it may be: only http(s), and never a
 * private-network address unless the page itself is on one (a local dev site).
 */
export function mapUrlRefusal(mapUrl: string, pageUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(mapUrl);
  } catch {
    return "not a URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return `refused ${parsed.protocol} source map; only http(s) maps are read`;
  const reason = privateTarget(mapUrl);
  if (reason && !privateTarget(pageUrl))
    return `refused source map on a private address (${reason})`;
  return undefined;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((char, index) => [char, index]));

/** Decodes one VLQ segment ("AAgBC") into its signed numbers. */
export function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = DIGIT.get(char);
    if (digit === undefined) throw new Error(`bad VLQ character ${char}`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    value = 0;
    shift = 0;
  }
  return values;
}

/** Decodes a version 3 source map. Index maps (sections) keep only their first section. */
export function decodeMap(json: unknown): DecodedMap {
  const map = (json ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(map.sections)
    ? (((map.sections[0] as Record<string, unknown> | undefined)?.map ?? {}) as Record<
        string,
        unknown
      >)
    : map;
  const root = typeof raw.sourceRoot === "string" && raw.sourceRoot ? raw.sourceRoot : "";
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).map((source) =>
    joinRoot(root, String(source ?? "")),
  );
  const names = (Array.isArray(raw.names) ? raw.names : []).map(String);
  const lines = decodeMappings(typeof raw.mappings === "string" ? raw.mappings : "");
  const content = Array.isArray(raw.sourcesContent)
    ? raw.sourcesContent.map((item) => (typeof item === "string" ? item : null))
    : undefined;
  return { sources, names, lines, ...(content ? { sourcesContent: content } : {}) };
}

function joinRoot(root: string, source: string): string {
  if (!root || /^[a-z]+:/i.test(source) || source.startsWith("/")) return source;
  return root.endsWith("/") ? root + source : `${root}/${source}`;
}

function decodeMappings(mappings: string): number[][][] {
  const state = [0, 0, 0, 0];
  return mappings.split(";").map((line) => {
    let column = 0;
    const segments: number[][] = [];
    for (const part of line.split(",")) {
      if (!part) continue;
      const values = decodeVlq(part);
      column += values[0] ?? 0;
      if (values.length < 4) continue;
      for (let index = 1; index < 5 && index < values.length; index++)
        state[index - 1] = (state[index - 1] ?? 0) + (values[index] ?? 0);
      segments.push(values.length >= 5 ? [column, ...state] : [column, ...state.slice(0, 3)]);
    }
    return segments.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  });
}

function segmentAt(segments: number[][], col: number): number[] | undefined {
  let found: number[] | undefined;
  for (const segment of segments) {
    if ((segment[0] ?? 0) > col) break;
    found = segment;
  }
  return found ?? segments[0];
}

/** The original location of a generated position: the last mapped segment at or before it. */
export function originalPosition(map: DecodedMap, at: MapPosition): OriginalPosition | undefined {
  const found = segmentAt(map.lines[at.line - 1] ?? [], at.col);
  const source = found ? map.sources[found[1] ?? -1] : undefined;
  if (!found || source === undefined) return undefined;
  const name = found[4] === undefined ? undefined : map.names[found[4]];
  return { source, line: (found[2] ?? 0) + 1, col: found[3] ?? 0, ...(name ? { name } : {}) };
}
