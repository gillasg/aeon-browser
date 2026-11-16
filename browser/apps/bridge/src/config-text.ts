// Edits a config as text. Comments, spacing and every other key stay where they were.
// A file that is not text is refused, never rewritten.

export interface JsonKey {
  name: string;
  keyAt: number;
  valueStart: number;
  valueEnd: number;
}

interface JsonObject {
  close: number;
  keys: JsonKey[];
}

/** Inserts, replaces or removes one property inside a top-level object. Undefined removes it. */
export function spliceJson(
  text: string,
  container: string,
  name: string,
  value: unknown | undefined,
): string {
  assertText(text);
  if (!text.trim()) return value === undefined ? text : freshObject(container, name, value);
  const start = skipSpaceAndComments(text, 0);
  if (text[start] !== "{") throw new Error("not a JSON object");
  const root = objectAt(text, start);
  const holder = root.keys.find((key) => key.name === container);
  if (!holder) return missingContainer(text, root, container, name, value);
  if (text[holder.valueStart] !== "{") throw new Error("container is not an object");
  const inner = objectAt(text, holder.valueStart);
  return spliceKey(text, inner, name, value);
}

/** Replaces one `[table.name]` block. Undefined removes that block and leaves the rest. */
export function spliceToml(
  text: string,
  table: string,
  name: string,
  body: string | undefined,
): string {
  assertText(text);
  const header = `[${table}.${name}]`;
  const lines = text.split(/\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return body === undefined ? text : appendBlock(text, body);
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end += 1;
  const next = [
    ...lines.slice(0, start),
    ...(body === undefined ? [] : body.split("\n")),
    ...lines.slice(end),
  ];
  return next.join("\n");
}

/**
 * Replaces one child of a top-level YAML map. `body` is the indented child, including its key
 * line. Undefined removes that child. Other keys and comments stay.
 */
export function spliceYaml(
  text: string,
  parent: string,
  body: string | undefined,
  child: string,
): string {
  assertText(text);
  const lines = text.split(/\n/);
  const start = lines.findIndex((line) => line === `${parent}:`);
  if (start < 0) return body === undefined ? text : appendBlock(text, `${parent}:\n${body}`);
  const sectionEnd = yamlSectionEnd(lines, start);
  const at = lines.findIndex(
    (line, index) => index > start && index < sectionEnd && line.startsWith(child),
  );
  if (at < 0) {
    if (body === undefined) return text;
    return [...lines.slice(0, sectionEnd), ...body.split("\n"), ...lines.slice(sectionEnd)].join(
      "\n",
    );
  }
  const childEnd = yamlChildEnd(lines, at, sectionEnd);
  const replacement = body === undefined ? [] : body.split("\n");
  return [...lines.slice(0, at), ...replacement, ...lines.slice(childEnd)].join("\n");
}

function assertText(text: string): void {
  if (text.includes("\0")) throw new Error("not text");
}

function freshObject(container: string, name: string, value: unknown): string {
  return JSON.stringify({ [container]: { [name]: value } }, null, 2) + "\n";
}

function missingContainer(
  text: string,
  root: JsonObject,
  container: string,
  name: string,
  value: unknown | undefined,
): string {
  if (value === undefined) return text;
  const insertion = `${JSON.stringify(container)}: ${JSON.stringify({ [name]: value })}`;
  return insertBefore(text, root, insertion);
}

function spliceKey(
  text: string,
  obj: JsonObject,
  name: string,
  value: unknown | undefined,
): string {
  const existing = obj.keys.find((key) => key.name === name);
  if (!existing) {
    if (value === undefined) return text;
    return insertBefore(text, obj, `${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  }
  if (value === undefined) return deleteKey(text, existing);
  return text.slice(0, existing.valueStart) + JSON.stringify(value) + text.slice(existing.valueEnd);
}

function insertBefore(text: string, obj: JsonObject, insertion: string): string {
  const comma = needsComma(text, obj) ? ", " : "";
  return text.slice(0, obj.close) + comma + insertion + text.slice(obj.close);
}

function needsComma(text: string, obj: JsonObject): boolean {
  const last = obj.keys[obj.keys.length - 1];
  if (!last) return false;
  return text[skipSpaceAndComments(text, last.valueEnd)] !== ",";
}

function deleteKey(text: string, key: JsonKey): string {
  let start = key.keyAt;
  let end = key.valueEnd;
  const after = skipSpaceAndComments(text, end);
  if (text[after] === ",") end = after + 1;
  else {
    let before = start - 1;
    while (before >= 0 && /\s/.test(text[before] ?? "")) before -= 1;
    if (text[before] === ",") start = before;
  }
  return text.slice(0, start) + text.slice(end);
}

function objectAt(text: string, open: number): JsonObject {
  if (text[open] !== "{") throw new Error("not an object");
  const keys: JsonKey[] = [];
  let i = open + 1;
  while (i < text.length) {
    i = skipSpaceAndComments(text, i);
    if (text[i] === "}") return { close: i, keys };
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    const key = readString(text, i);
    const colon = key ? skipSpaceAndComments(text, key.end) : i;
    if (!key || text[colon] !== ":") throw new Error("expected a key");
    const valueStart = skipSpaceAndComments(text, colon + 1);
    const valueEnd = endOfValue(text, valueStart);
    keys.push({ name: key.value, keyAt: i, valueStart, valueEnd });
    i = valueEnd;
  }
  throw new Error("unterminated object");
}

function endOfValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return readString(text, i)?.end ?? fail("unterminated string");
  if (ch === "{" || ch === "[") return endOfBracket(text, i);
  let end = i;
  while (end < text.length && !",}]/".includes(text[end] ?? "") && !/\s/.test(text[end] ?? ""))
    end += 1;
  if (end === i) throw new Error("missing value");
  return end;
}

function endOfBracket(text: string, i: number): number {
  const open = text[i] ?? "";
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  while (i < text.length) {
    const skipped = commentEnd(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] === '"') {
      i = readString(text, i)?.end ?? fail("unterminated string");
      continue;
    }
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new Error("unterminated object");
}

function readString(text: string, i: number): { value: string; end: number } | undefined {
  if (text[i] !== '"') return undefined;
  let value = "";
  i += 1;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\\") {
      value += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    if (ch === "\n") return undefined;
    value += ch;
    i += 1;
  }
  return undefined;
}

function skipSpaceAndComments(text: string, i: number): number {
  while (i < text.length) {
    const skipped = commentEnd(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (/\s/.test(text[i] ?? "")) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function commentEnd(text: string, i: number): number {
  if (text[i] === "/" && text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl + 1;
  }
  if (text[i] === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  return i;
}

function yamlSectionEnd(lines: readonly string[], start: number): number {
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() && !line.startsWith(" ") && !line.startsWith("#")) break;
    end += 1;
  }
  return end;
}

function yamlChildEnd(lines: readonly string[], at: number, sectionEnd: number): number {
  let end = at + 1;
  while (end < sectionEnd) {
    const line = lines[end] ?? "";
    if (line.startsWith("  ") && !line.startsWith("   ") && line.trim()) break;
    end += 1;
  }
  return end;
}

function appendBlock(text: string, block: string): string {
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${base}${block.endsWith("\n") ? block : `${block}\n`}`;
}

function fail(message: string): never {
  throw new Error(message);
}
