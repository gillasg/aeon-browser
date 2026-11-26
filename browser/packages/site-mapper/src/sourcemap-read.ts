import { optional } from "./code.js";
import {
  decodeMap,
  discoverMapUrl,
  mapUrlRefusal,
  originalPosition,
  type DecodedMap,
  type MapPosition,
  type OriginalPosition,
} from "./sourcemap.js";

// Reads a script's source map out of band and maps generated positions back to the original
// file and line. Used by page.code.sourcemaps(), page.sources({original: true}) and page.why.

export interface SourceMapsOptions {
  /** Generated positions in the script to map back. */
  positions?: readonly MapPosition[];
  /** Response headers the page already saw for the script (SourceMap, X-SourceMap). */
  headers?: Record<string, string>;
  /** The page the script belongs to, for the private-network rule. Defaults to the script. */
  pageUrl?: string;
  /** Include up to this many characters of each original file's text (default 0). */
  contentChars?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface SourceMapsResult {
  file: string;
  map?: string;
  sources: string[];
  hasContent: boolean;
  positions: (MapPosition & { original?: OriginalPosition })[];
  content?: Record<string, string>;
  refused?: string;
  note?: string;
}

const MAX_BYTES = 8_000_000;

export async function sourceMaps(
  file: string,
  options: SourceMapsOptions = {},
): Promise<SourceMapsResult> {
  const io = ioLimits(options);
  const positions = (options.positions ?? []).slice(0, 200);
  const pageUrl = options.pageUrl ?? file;
  const empty = { file, sources: [], hasContent: false, positions: [...positions] };
  const fileRefusal = mapUrlRefusal(file, pageUrl);
  if (fileRefusal) return { ...empty, refused: fileRefusal };
  const script = await optional(file, io.maxBytes, io.timeoutMs);
  if (!script) return { ...empty, note: "script could not be read" };
  const headers = { ...script.headers, ...options.headers };
  const mapUrl = discoverMapUrl(file, script.text, headers) ?? `${file.split(/[?#]/)[0]}.map`;
  const refused = mapUrlRefusal(mapUrl, pageUrl);
  if (refused) return { ...empty, map: mapUrl, refused };
  const decoded = await readMap(mapUrl, io);
  if (typeof decoded === "string") return { ...empty, map: mapUrl, note: decoded };
  return mapped(file, mapUrl, decoded, positions, options.contentChars ?? 0);
}

function mapped(
  file: string,
  mapUrl: string,
  decoded: DecodedMap,
  positions: MapPosition[],
  contentChars: number,
): SourceMapsResult {
  const content = contentOf(decoded.sources, decoded.sourcesContent, contentChars);
  return {
    file,
    map: mapUrl,
    sources: decoded.sources.slice(0, 500),
    hasContent: Boolean(decoded.sourcesContent?.some(Boolean)),
    positions: positions.map((at) => {
      const original = originalPosition(decoded, at);
      return original ? { ...at, original } : { ...at };
    }),
    ...(content ? { content } : {}),
  };
}

function ioLimits(options: SourceMapsOptions): { maxBytes: number; timeoutMs: number } {
  return {
    maxBytes: Math.min(options.maxBytes ?? MAX_BYTES, 20_000_000),
    timeoutMs: Math.min(options.timeoutMs ?? 15_000, 60_000),
  };
}

/** The decoded map, or a note saying why there is none. */
async function readMap(
  mapUrl: string,
  io: { maxBytes: number; timeoutMs: number },
): Promise<DecodedMap | string> {
  const mapFile = await optional(mapUrl, io.maxBytes, io.timeoutMs);
  if (!mapFile || mapFile.status >= 400) return "no source map";
  try {
    return decodeMap(JSON.parse(mapFile.text));
  } catch {
    return "source map was not a valid map";
  }
}

function contentOf(
  sources: string[],
  content: (string | null)[] | undefined,
  chars: number,
): Record<string, string> | undefined {
  if (!content || chars <= 0) return undefined;
  const out: Record<string, string> = {};
  let left = Math.min(chars, 2_000_000);
  sources.forEach((source, index) => {
    const text = content[index];
    if (!text || left <= 0) return;
    out[source] = text.slice(0, left);
    left -= out[source].length;
  });
  return out;
}
