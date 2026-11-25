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

/** What an element shows, trimmed and lowercased, plus its number when it reads as one. */
export function provNormalize(text: unknown): ProvTargetValue {
  const raw = String(text ?? "");
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const out: ProvTargetValue = { raw, trimmed, lower: trimmed.toLowerCase() };
  const shaped = /^[-+(]?\s*[$€£¥₹]?\s*[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\s*%?\)?$/;
  if (!shaped.test(trimmed) || !/\d/.test(trimmed)) return out;
  const negative = /^\(.*\)$/.test(trimmed) || /^-|^[$€£¥₹]\s*-/.test(trimmed);
  const digits = trimmed.replace(/[^\d.]/g, "");
  const value = Number(digits);
  if (digits && Number.isFinite(value)) out.num = negative ? -value : value;
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
    if (own !== undefined && Math.abs(own - target.num) < 1e-9) return "normalized";
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
