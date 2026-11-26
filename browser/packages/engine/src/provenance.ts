// Point to provenance, the pure half: normalize what an element shows, find it inside JSON (response
// bodies and page hydration state) as RFC 6901 pointers, rank the hits deterministically, and match
// a request to a mapped site operation. No model, no page access. Every function is self-contained
// so code-api-why.ts can embed it by source into the realm and the tests run the same code.

export type ProvMatchKind = "exact" | "normalized" | "substring";

export interface ProvTargetValue {
  raw: string;
  trimmed: string;
  lower: string;
  num?: number;
  /** How far a raw number may sit from num and still be the same value (compact 2.8K is ±50). */
  tol?: number;
}

export interface ProvMatch {
  pointer: string;
  kind: ProvMatchKind;
  depth: number;
  leaf: string | number | boolean;
}

export interface ProvSearchOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxMatches?: number;
}

export interface ProvCandidate extends ProvMatch {
  /** Higher is newer; hydration state is 0, network bodies count up in arrival order. */
  recency: number;
  source: string;
}

export interface ProvOperation {
  id: string;
  method?: string;
  path?: string;
}

/**
 * What an element shows, trimmed and lowercased, plus its number when it reads as one: thousands
 * separators (10,385,963), compact suffixes (2.8K, 1.2M, 3.4B, with the rounding they imply as
 * `tol`), European and currency decimals (59,99€, €21, ₹1,999) and a trailing unit word (ratings).
 */
export function provNormalize(text: unknown): ProvTargetValue {
  const raw = text === undefined || text === null ? "" : String(text);
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const out: ProvTargetValue = { raw, trimmed, lower: trimmed.toLowerCase() };
  const units =
    /\s+(ratings?|reviews?|views?|viewers?|watching|stars?|total|followers?|likes?|votes?|players?|users?|members?|comments?|downloads?|items?|results?)$/i;
  let core = trimmed.replace(units, "").replace(/\s+/g, "");
  const negative = /^\(.*\)$/.test(core) || /^-|^[$€£¥₹]-/.test(core);
  core = core.replace(/^[(+-]+|\)$/g, "").replace(/^(US|CA|AU)?[$€£¥₹]|[$€£¥₹]$/g, "");
  core = core.replace(/^[-+]/, "").replace(/%$/, "");
  const shaped = /^(\d[\d.,]*)([kmbt])?$/i.exec(core);
  if (!shaped || !shaped[1]) return out;
  let digits = shaped[1];
  const comma = digits.lastIndexOf(","),
    dot = digits.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    // Both separators: the last one is the decimal point.
    const decimal = comma > dot ? "," : ".";
    digits = digits.split(decimal === "," ? "." : ",").join("");
    digits = digits.replace(",", ".");
  } else if (comma >= 0) {
    const groups = digits.split(",");
    const thousands = groups.slice(1).every((group) => group.length === 3) && groups.length > 1;
    if (thousands && (groups.length > 2 || !shaped[2])) digits = groups.join("");
    else if (groups.length === 2) digits = groups.join(".");
    else return out;
  } else if (dot >= 0) {
    const groups = digits.split(".");
    if (groups.length > 2) {
      if (!groups.slice(1).every((group) => group.length === 3)) return out;
      digits = groups.join("");
    }
  }
  if (!/^\d+(\.\d+)?$/.test(digits)) return out;
  const scale: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const factor = shaped[2] ? (scale[shaped[2].toLowerCase()] ?? 1) : 1;
  const places = (digits.split(".")[1] ?? "").length;
  const value = Number(digits) * factor;
  if (!Number.isFinite(value)) return out;
  out.num = negative ? -value : value;
  if (factor > 1) out.tol = (0.5 * factor) / Math.pow(10, places);
  return out;
}

/** How a JSON leaf matches the target: exact text, the same number or text in another format, or contains it. */
export function provLeafKind(
  leaf: unknown,
  target: ProvTargetValue,
): "exact" | "normalized" | "substring" | undefined {
  if (leaf === null || leaf === undefined || typeof leaf === "object") return undefined;
  if (!target.trimmed) return undefined;
  const text = String(leaf);
  if (text === target.raw || text === target.trimmed) return "exact";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === target.trimmed) return "exact";
  if (clean.toLowerCase() === target.lower) return "normalized";
  if (target.num !== undefined) {
    const own = typeof leaf === "number" ? leaf : provNormalize(clean).num;
    if (own !== undefined && Math.abs(own - target.num) <= (target.tol ?? 1e-9))
      return "normalized";
  }
  if (
    typeof leaf === "string" &&
    target.trimmed.length >= 3 &&
    clean.toLowerCase().includes(target.lower)
  )
    return "substring";
  return undefined;
}

/** Every leaf in root that matches, as RFC 6901 pointers; bounded by depth, nodes, matches and cycles. */
export function provSearch(
  root: unknown,
  target: ProvTargetValue,
  options: ProvSearchOptions = {},
): ProvMatch[] {
  const maxDepth = options.maxDepth ?? 24;
  const maxNodes = options.maxNodes ?? 60000;
  const maxMatches = options.maxMatches ?? 50;
  const found: ProvMatch[] = [];
  const seen = new WeakSet<object>();
  const escape = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
  const stack: { value: unknown; pointer: string; depth: number }[] = [
    { value: root, pointer: "", depth: 0 },
  ];
  let nodes = 0;
  while (stack.length && nodes < maxNodes && found.length < maxMatches) {
    const { value, pointer, depth } = stack.pop() as {
      value: unknown;
      pointer: string;
      depth: number;
    };
    nodes++;
    if (value && typeof value === "object") {
      if (seen.has(value as object) || depth >= maxDepth) continue;
      seen.add(value as object);
      const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value);
      for (let i = keys.length - 1; i >= 0; i--)
        stack.push({
          value: (value as Record<string, unknown>)[keys[i] as string],
          pointer: pointer + "/" + escape(keys[i] as string),
          depth: depth + 1,
        });
      continue;
    }
    const kind = provLeafKind(value, target);
    if (kind) found.push({ pointer, kind, depth, leaf: value as string | number | boolean });
  }
  return found;
}

/** Best first: exact over normalized over substring, newer response over older, deeper field over shallower. */
export function provRank<T extends ProvCandidate>(candidates: T[]): T[] {
  const score: Record<string, number> = { exact: 3, normalized: 2, substring: 1 };
  return candidates
    .slice()
    .sort(
      (a, b) =>
        (score[b.kind] ?? 0) - (score[a.kind] ?? 0) ||
        b.recency - a.recency ||
        b.depth - a.depth ||
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
        (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0),
    );
}

/** The mapped operation whose method and path template fit this request, or undefined. */
export function provOperation(
  method: string,
  url: string,
  operations: ProvOperation[],
): string | undefined {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url).split("?")[0] ?? "";
  }
  const verb = String(method || "GET").toUpperCase();
  const fits = (template: string): boolean => {
    const parts = template.split("?")[0]?.split("/") ?? [];
    const have = path.split("/");
    if (parts.length !== have.length) return false;
    return parts.every((part, i) => /^[{:]/.test(part) || part === have[i]);
  };
  const hits = (operations || []).filter(
    (op) => op && op.path && String(op.method || "GET").toUpperCase() === verb && fits(op.path),
  );
  // Prefer the template with the most literal segments.
  const literal = (op: ProvOperation): number =>
    (op.path ?? "").split("/").filter((part) => part && !/^[{:]/.test(part)).length;
  hits.sort((a, b) => literal(b) - literal(a) || (a.id < b.id ? -1 : 1));
  return hits[0]?.id;
}

/** The last path segment of a pointer that is a name, not an index: the JSON key behind the value. */
export function provLeafKey(pointer: string): string | undefined {
  const parts = pointer.split("/").slice(1).reverse();
  const key = parts.find((part) => !/^\d+$/.test(part));
  return key ? key.replace(/~1/g, "/").replace(/~0/g, "~") : undefined;
}

export const provenanceFunctions = [
  provNormalize,
  provLeafKind,
  provSearch,
  provRank,
  provOperation,
  provLeafKey,
];
