export function siteName(args: Record<string, unknown>): string | undefined {
  const title = stringValue(args, "title", "site", "domain", "hostname");
  if (title) return title.replace(/^www\./i, "").replace(/\s+(?:page|website)$/i, "");
  const url = stringValue(args, "url", "href");
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

export function fileName(args: Record<string, unknown>): string | undefined {
  const path = stringValue(args, "path", "filePath", "file_path", "file", "filename");
  return path?.replace(/\\/g, "/").split("/").at(-1);
}

export function stringValue(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

export function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function boundedText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 144 ? `${normalized.slice(0, 141)}…` : normalized;
}
