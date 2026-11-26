import type { Sample } from "../types.js";

// Evidence behind a schema: how many samples were seen and how often each response field was
// present, so a reader can tell a field seen once from one seen every time.

export interface FieldObservation {
  presentCount: number;
  presenceRatio: number;
}

export interface Observations {
  sampleCount: number;
  fields: Record<string, FieldObservation>;
}

const MAX_DEPTH = 4;
const MAX_FIELDS = 200;

/** Per-field presence over the JSON response bodies of these samples, keyed by JSON pointer. */
export function observations(samples: readonly Sample[]): Observations | undefined {
  const counts = new Map<string, number>();
  let sampleCount = 0;
  for (const sample of samples) {
    const body = parse(sample.responseBody);
    if (body === undefined) continue;
    sampleCount++;
    const seen = new Set<string>();
    walk(body, "", 0, seen);
    for (const pointer of seen) counts.set(pointer, (counts.get(pointer) ?? 0) + 1);
  }
  if (!sampleCount) return undefined;
  const fields: Record<string, FieldObservation> = {};
  for (const [pointer, presentCount] of [...counts].slice(0, MAX_FIELDS))
    fields[pointer] = {
      presentCount,
      presenceRatio: Math.round((presentCount / sampleCount) * 1000) / 1000,
    };
  return { sampleCount, fields };
}

function parse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function walk(value: unknown, pointer: string, depth: number, seen: Set<string>): void {
  if (depth >= MAX_DEPTH || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) walk(item, `${pointer}/*`, depth + 1, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    seen.add(path);
    walk(child, path, depth + 1, seen);
  }
}
