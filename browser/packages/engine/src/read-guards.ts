// Facts the page already showed, so the model does not invent a total or a location.

const STATED = /\b(\d{1,7})\s+(?:orders|results|items|listings|products|rows)\b/i;
const LOCATION =
  /(?:deliver to|delivery to|ship to|pincode|pin code)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 ,.-]{2,40})/i;

export function statedCount(text: string): number | undefined {
  const value = Number(STATED.exec(text)?.[1] ?? "");
  return value > 0 ? value : undefined;
}

export function listContradiction(text: string, count: number): string | undefined {
  const stated = statedCount(text);
  if (stated && count === 0) return `contradiction: "page says ${stated}, list has 0"`;
  return undefined;
}

export function partialListLine(shown: number, total: number): string | undefined {
  if (!(total > shown)) return undefined;
  return `list: ${shown} of ${total} (partial)`;
}

export function productLocation(text: string): string | undefined {
  const value = LOCATION.exec(text)?.[1]?.trim();
  return value || undefined;
}

export function readGuard(input: {
  text?: string;
  count?: number;
  shown?: number;
  total?: number;
}): { contradiction?: string; location?: string; partial?: string; total?: number } {
  const text = String(input.text ?? "");
  const count = typeof input.count === "number" ? input.count : 0;
  const shown = typeof input.shown === "number" ? input.shown : count;
  const stated = statedCount(text);
  const total = typeof input.total === "number" ? input.total : stated;
  const contradiction = listContradiction(text, count);
  const location = productLocation(text);
  const partial = typeof total === "number" ? partialListLine(shown, total) : undefined;
  return {
    ...(contradiction ? { contradiction } : {}),
    ...(location ? { location } : {}),
    ...(partial ? { partial } : {}),
    ...(typeof total === "number" ? { total } : {}),
  };
}
