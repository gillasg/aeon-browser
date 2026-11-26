import type { Exchange } from "./types.js";

// Heartbeats, telemetry pings and regular polls fire on a fixed clock, not because the user did
// something. They stay in the model as reads, but lose any page step so they never count as what
// a click sent.

const MIN_HITS = 4;
const MIN_INTERVAL_MS = 1_000;
/** Largest spread of the gaps around their median, as a share of it, that still counts as a clock. */
const MAX_JITTER = 0.15;

function endpointKey(exchange: Exchange): string {
  try {
    const url = new URL(exchange.url);
    return `${exchange.method} ${url.origin}${url.pathname}`;
  } catch {
    return `${exchange.method} ${exchange.url}`;
  }
}

/** The endpoints called on a fixed interval: `METHOD origin/path` keys. */
export function periodicEndpoints(exchanges: readonly Exchange[]): Set<string> {
  const times = new Map<string, number[]>();
  for (const exchange of exchanges) {
    const key = endpointKey(exchange);
    times.set(key, [...(times.get(key) ?? []), exchange.startedAt]);
  }
  const periodic = new Set<string>();
  for (const [key, list] of times) if (isClock(list)) periodic.add(key);
  return periodic;
}

function isClock(list: number[]): boolean {
  if (list.length < MIN_HITS) return false;
  const sorted = [...list].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((time, index) => time - (sorted[index] ?? time));
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
  if (median < MIN_INTERVAL_MS) return false;
  return gaps.every((gap) => Math.abs(gap - median) <= median * MAX_JITTER);
}

/** The same exchanges, with page steps removed from calls that run on a clock. */
export function withoutPeriodicSteps<T extends { exchange: Exchange }>(items: T[]): T[] {
  const periodic = periodicEndpoints(items.map((item) => item.exchange));
  if (!periodic.size) return items;
  return items.map((item) => {
    if (!item.exchange.step || !periodic.has(endpointKey(item.exchange))) return item;
    const exchange: Exchange = { ...item.exchange };
    delete exchange.step;
    return { ...item, exchange };
  });
}
