// page.download.parse, pure: a downloaded or workspace file's text straight into rows. CSV, TSV,
// JSON, NDJSON and HTML tables parse here with no dependency; XLSX and PDF say so clearly. Paths
// are confined lexically before any read (the host then resolves symlinks against its root).

export type FileFormat = "csv" | "tsv" | "json" | "ndjson" | "html";

// A relative path that stays inside its root, or an absolute one under an allowed root, else an
// error. Returns the path with forward slashes and no "." parts.
export function confineFilePath(path: unknown, roots: unknown = []): string {
  if (typeof path !== "string" || !path.trim())
    throw new Error("INVALID_INPUT: page.download.parse needs a file path");
  if (path.includes("\0")) throw new Error("PATH_OUTSIDE_ROOT: the path holds a NUL byte");
  const slashed = path.replace(/\\/g, "/");
  const absolute = /^([a-zA-Z]:)?\//.test(slashed);
  const parts = slashed.split("/").filter((part) => part && part !== ".");
  if (parts.includes(".."))
    throw new Error("PATH_OUTSIDE_ROOT: " + path + " climbs out of its folder with ..");
  if (!absolute) return parts.join("/");
  const drive = /^[a-zA-Z]:/.exec(slashed)?.[0] ?? "";
  const full = (drive ? "" : "/") + parts.join("/");
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (typeof root !== "string" || !root) continue;
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const same = (a: string, b: string): boolean =>
      drive ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (
      same(full.slice(0, base.length), base) &&
      (full.length === base.length || full[base.length] === "/")
    )
      return full;
  }
  throw new Error(
    "PATH_OUTSIDE_ROOT: " + path + " is not inside the workspace or an allowed download folder",
  );
}

export function detectFileFormat(name: string, text: string, mime = ""): FileFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "tsv" || /tab-separated/.test(mime)) return "tsv";
  if (ext === "csv" || /text\/csv/.test(mime)) return "csv";
  if (ext === "ndjson" || ext === "jsonl" || /ndjson|jsonl/.test(mime)) return "ndjson";
  if (ext === "json" || /json/.test(mime)) return "json";
  if (ext === "html" || ext === "htm" || /html/.test(mime)) return "html";
  const head = text.trimStart();
  if (/^</.test(head)) return "html";
  if (/^[[{]/.test(head)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      return "ndjson";
    }
  }
  const first = head.split(/\r?\n/, 1)[0] ?? "";
  return first.split("\t").length > first.split(",").length ? "tsv" : "csv";
}

// RFC 4180: quoted fields, doubled quotes, newlines inside quotes, CRLF.
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') ((field += '"'), i++);
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) (row.push(field), (field = ""));
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      (row.push(field), rows.push(row), (row = []), (field = ""));
    } else field += char;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  return rows.filter((cells) => cells.length > 1 || cells[0] !== "");
}

export function typedCell(value: string): unknown {
  const text = value.trim();
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return Number(text);
  if (text === "true" || text === "false") return text === "true";
  if (text === "" || text === "null") return null;
  return value;
}

export function rowsToObjects(
  table: string[][],
  options: { header?: boolean; types?: boolean } = {},
): unknown[] {
  if (!table.length) return [];
  const typed = options.types === false ? (cell: string) => cell : typedCell;
  if (options.header === false) return table.map((row) => row.map(typed));
  const seen = new Map<string, number>();
  const names = (table[0] ?? []).map((raw, index) => {
    const name = raw.trim() || "column" + (index + 1);
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count > 1 ? name + "_" + count : name;
  });
  return table
    .slice(1)
    .map((row) => Object.fromEntries(names.map((name, index) => [name, typed(row[index] ?? "")])));
}

const decode = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Every <table> in a document as string cells; the first row is the header when it holds <th>.
export function htmlTables(html: string): { header: boolean; rows: string[][] }[] {
  const clean = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  return [...clean.matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => {
    const rows = [...match[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((tr) =>
      [...tr[0].matchAll(/<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) => decode(cell[2] ?? "")),
    );
    return { header: /<tr[^>]*>\s*<th/i.test(match[0]), rows: rows.filter((row) => row.length) };
  });
}

export interface ParseOptions {
  format?: FileFormat;
  mime?: string;
  header?: boolean;
  types?: boolean;
  limit?: number;
  table?: number;
}

export function parseFileText(name: string, text: string, options: ParseOptions = {}): unknown {
  if (/\.(xlsx|xlsm|xls|pdf|zip|docx)$/i.test(name))
    throw new Error(
      "UNSUPPORTED: " +
        name +
        " is a binary " +
        /\.([a-z]+)$/i.exec(name)?.[1] +
        " file; no parser for it ships here. Save it as CSV, or read it in the page (page.read on a PDF tab).",
    );
  const format = options.format ?? detectFileFormat(name, text, options.mime);
  const cap = (rows: unknown[]): unknown[] => (options.limit ? rows.slice(0, options.limit) : rows);
  let rows: unknown;
  if (format === "json") rows = JSON.parse(text);
  else if (format === "ndjson")
    rows = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error("INVALID_INPUT: " + name + " line " + (index + 1) + " is not JSON");
        }
      });
  else if (format === "html") {
    const tables = htmlTables(text);
    const picked = tables[options.table ?? 0];
    rows = picked
      ? rowsToObjects(picked.rows, { ...options, header: options.header ?? picked.header })
      : [];
    return { format, rows: cap(rows as unknown[]), tables: tables.length };
  } else rows = rowsToObjects(parseDelimited(text, format === "tsv" ? "\t" : ","), options);
  return { format, rows: Array.isArray(rows) ? cap(rows) : rows };
}
