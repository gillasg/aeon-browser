// Boost wire rules: declarative per-host rewrites of the network, applied through DevTools Fetch
// only on tabs whose host has an active rule. A rule matches a request URL (a glob with * and ?)
// and blocks it, edits its JSON response, its response headers or its HTML before the page sees
// it. Everything is data: no rule carries code, injected HTML can hold no script, and auth
// headers and cookies are never read, changed or reported.

export type JsonOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "delete"; path: string }
  | { op: "filter"; path: string; where: JsonWhere; keep?: boolean }
  | { op: "map"; path: string; set?: Record<string, unknown>; delete?: string[] };

export interface JsonWhere {
  key: string;
  equals?: unknown;
  in?: unknown[];
  exists?: boolean;
  contains?: string;
}

export type HtmlOp =
  | { op: "inject"; at: "head-end" | "body-start" | "body-end"; html: string }
  | { op: "strip"; tag: string; contains?: string };

export interface HeaderEdit {
  name: string;
  /** Set to this value; leave out to remove the header. */
  value?: string;
}

export interface WireRule {
  /** A glob on the whole request URL: * is any run of characters, ? one character. */
  match: string;
  method?: string;
  action: "block" | "json" | "headers" | "html";
  json?: JsonOp[];
  headers?: HeaderEdit[];
  html?: HtmlOp[];
}

export interface WireHeader {
  name: string;
  value: string;
}

// Headers that carry or set credentials, or protect the page: never touched by a rule.
const PROTECTED_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|set-cookie2|www-authenticate|proxy-authenticate|x-csrf-token|x-xsrf-token|x-auth-token|x-api-key|content-security-policy|strict-transport-security)$/i;
// HTML a rule may inject is markup only: no scripts, frames, plugins, handlers or script URLs.
const ACTIVE_HTML =
  /<\s*(script|iframe|object|embed|frame|meta|base|link)\b|\son\w+\s*=|javascript:/i;
// Sign-in, sign-up and password pages are never rewritten: the password lock owns them.
const SIGN_IN_PATH =
  /(^|[/._-])(login|log-in|signin|sign-in|signup|sign-up|auth|oauth|sso|password|passwd|account\/recover|2fa|mfa|otp)([/._?-]|$)/i;
const MAX_BODY = 5 * 1024 * 1024;
const TAG = /^[a-z][a-z0-9-]*$/i;

export const isProtectedHeader = (name: string): boolean => PROTECTED_HEADER.test(name.trim());

export function isSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SIGN_IN_PATH.test(parsed.pathname) || /^(login|auth|accounts|sso)\./i.test(parsed.host);
  } catch {
    return true;
  }
}

export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validHtmlOp(op: unknown): op is HtmlOp {
  if (!isRecord(op)) return false;
  if (op.op === "inject")
    return (
      ["head-end", "body-start", "body-end"].includes(String(op.at)) &&
      typeof op.html === "string" &&
      !ACTIVE_HTML.test(op.html)
    );
  return op.op === "strip" && typeof op.tag === "string" && TAG.test(op.tag);
}

function validJsonOp(op: unknown): op is JsonOp {
  if (!isRecord(op) || typeof op.path !== "string") return false;
  if (op.op === "set") return "value" in op;
  if (op.op === "delete") return op.path.length > 0;
  if (op.op === "filter") return isRecord(op.where) && typeof op.where.key === "string";
  return op.op === "map" && (isRecord(op.set) || Array.isArray(op.delete));
}

const validHeader = (edit: unknown): edit is HeaderEdit =>
  isRecord(edit) &&
  typeof edit.name === "string" &&
  /^[a-z0-9-]+$/i.test(edit.name) &&
  !isProtectedHeader(edit.name) &&
  (edit.value === undefined || typeof edit.value === "string");

/** Keeps the well-formed, safe parts of a rule; undefined when nothing usable is left. */
export function sanitizeWireRule(raw: unknown): WireRule | undefined {
  if (!isRecord(raw) || typeof raw.match !== "string" || !raw.match.trim()) return undefined;
  const base = {
    match: raw.match.trim(),
    ...(typeof raw.method === "string" ? { method: raw.method.toUpperCase() } : {}),
  };
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  if (raw.action === "block") return { ...base, action: "block" };
  if (raw.action === "json") {
    const json = list(raw.json).filter(validJsonOp);
    return json.length ? { ...base, action: "json", json } : undefined;
  }
  if (raw.action === "headers") {
    const headers = list(raw.headers).filter(validHeader);
    return headers.length ? { ...base, action: "headers", headers } : undefined;
  }
  if (raw.action === "html") {
    const html = list(raw.html).filter(validHtmlOp);
    return html.length ? { ...base, action: "html", html } : undefined;
  }
  return undefined;
}

export function wireRuleMatches(rule: WireRule, url: string, method = "GET"): boolean {
  if (rule.method && rule.method !== method.toUpperCase()) return false;
  return globToRegExp(rule.match).test(url);
}

export function matchingRules(rules: WireRule[], url: string, method = "GET"): WireRule[] {
  if (!rules.length || isSignInUrl(url)) return [];
  return rules.filter((rule) => wireRuleMatches(rule, url, method));
}

/** The Fetch.enable patterns for a tab's rules: blocks pause at the request, the rest at the response. */
export function fetchPatterns(
  rules: WireRule[],
): { urlPattern: string; requestStage: "Request" | "Response" }[] {
  const seen = new Set<string>();
  const patterns: { urlPattern: string; requestStage: "Request" | "Response" }[] = [];
  for (const rule of rules) {
    const requestStage = rule.action === "block" ? "Request" : "Response";
    const key = `${requestStage} ${rule.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push({ urlPattern: rule.match, requestStage });
  }
  return patterns;
}

/** A readable line per rule, with no header values, bodies or query strings. */
export function describeWireRule(rule: WireRule): string {
  const what = `requests matching ${rule.match.replace(/\?.*$/, "?…")}`;
  if (rule.action === "block") return `Blocks ${what}`;
  if (rule.action === "json")
    return `Edits the JSON of ${what} (${rule.json?.length ?? 0} changes)`;
  if (rule.action === "headers")
    return `Changes the ${(rule.headers ?? []).map((h) => h.name).join(", ")} headers of ${what}`;
  return `Edits the HTML of ${what}`;
}

// JSON transforms. A path is dot separated: keys, array indexes, and * for every item.

function parentsOf(root: unknown, segments: string[]): unknown[] {
  let level: unknown[] = [root];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const node of level) {
      if (segment === "*" && Array.isArray(node)) next.push(...node);
      else if (segment === "*" && isRecord(node)) next.push(...Object.values(node));
      else if (Array.isArray(node) || isRecord(node))
        next.push((node as Record<string, unknown>)[segment]);
    }
    level = next.filter((node) => node !== undefined && node !== null);
  }
  return level;
}

const splitPath = (path: string): string[] => (path ? path.split(".") : []);

/** Whether one JSON object satisfies a where clause (also used by live MCP tap filters). */
export function whereHolds(item: unknown, where: JsonWhere): boolean {
  if (!isRecord(item)) return false;
  const value = item[where.key];
  if (where.exists !== undefined) return (value !== undefined) === where.exists;
  if (where.in) return where.in.some((wanted) => wanted === value);
  if (where.contains !== undefined)
    return String(value ?? "")
      .toLowerCase()
      .includes(where.contains.toLowerCase());
  return value === where.equals;
}

const SAFE_KEY = (key: string): boolean =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";

function setAt(root: unknown, segments: string[], value: unknown): void {
  const last = segments[segments.length - 1];
  if (last === undefined || !SAFE_KEY(last)) return;
  for (const parent of parentsOf(root, segments.slice(0, -1))) {
    const targets =
      last === "*"
        ? Object.keys(parent as object)
        : [last].filter(() => isRecord(parent) || Array.isArray(parent));
    for (const key of targets) (parent as Record<string, unknown>)[key] = structuredClone(value);
  }
}

function deleteAt(root: unknown, segments: string[]): void {
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  for (const parent of parentsOf(root, segments.slice(0, -1))) {
    if (Array.isArray(parent) && /^\d+$/.test(last)) parent.splice(Number(last), 1);
    else if (isRecord(parent)) delete parent[last];
  }
}

function filterAt(root: unknown, op: Extract<JsonOp, { op: "filter" }>): unknown {
  const keep = op.keep !== false;
  const apply = (list: unknown[]): unknown[] =>
    list.filter((item) => whereHolds(item, op.where) === keep);
  if (!op.path) return Array.isArray(root) ? apply(root) : root;
  const segments = splitPath(op.path);
  const last = segments[segments.length - 1] ?? "";
  for (const parent of parentsOf(root, segments.slice(0, -1))) {
    const record = parent as Record<string, unknown>;
    if (Array.isArray(record[last])) record[last] = apply(record[last] as unknown[]);
  }
  return root;
}

function mapAt(root: unknown, op: Extract<JsonOp, { op: "map" }>): void {
  for (const node of parentsOf(root, splitPath(op.path))) {
    const items = Array.isArray(node) ? node : [node];
    for (const item of items) {
      if (!isRecord(item)) continue;
      for (const [key, value] of Object.entries(op.set ?? {}))
        if (SAFE_KEY(key)) item[key] = structuredClone(value);
      for (const key of op.delete ?? []) delete item[key];
    }
  }
}

export function applyJsonOps(data: unknown, ops: JsonOp[]): unknown {
  let root = structuredClone(data);
  for (const op of ops) {
    if (op.op === "set") setAt(root, splitPath(op.path), op.value);
    else if (op.op === "delete") deleteAt(root, splitPath(op.path));
    else if (op.op === "filter") root = filterAt(root, op);
    else mapAt(root, op);
  }
  return root;
}

// HTML transforms: string edits on the document before it is parsed.

function injectHtml(html: string, op: Extract<HtmlOp, { op: "inject" }>): string {
  const anchors = {
    "head-end": { find: /<\/head\s*>/i, before: true },
    "body-start": { find: /<body\b[^>]*>/i, before: false },
    "body-end": { find: /<\/body\s*>/i, before: true },
  } as const;
  const anchor = anchors[op.at];
  const found = anchor.find.exec(html);
  if (!found) return op.at === "body-end" ? html + op.html : html;
  const at = anchor.before ? found.index : found.index + found[0].length;
  return html.slice(0, at) + op.html + html.slice(at);
}

function stripTags(html: string, op: Extract<HtmlOp, { op: "strip" }>): string {
  const pattern = new RegExp(`<${op.tag}\\b[^>]*>[\\s\\S]*?<\\/${op.tag}\\s*>`, "gi");
  const wanted = op.contains?.toLowerCase();
  return html.replace(pattern, (whole) =>
    !wanted || whole.toLowerCase().includes(wanted) ? "" : whole,
  );
}

export function applyHtmlOps(html: string, ops: HtmlOp[]): string {
  return ops.reduce(
    (text, op) => (op.op === "inject" ? injectHtml(text, op) : stripTags(text, op)),
    html,
  );
}

/** Applies header edits, leaving protected headers exactly as they came. */
export function applyHeaderEdits(headers: WireHeader[], edits: HeaderEdit[]): WireHeader[] {
  let result = [...headers];
  for (const edit of edits) {
    if (isProtectedHeader(edit.name)) continue;
    const name = edit.name.toLowerCase();
    result = result.filter((header) => header.name.toLowerCase() !== name);
    if (edit.value !== undefined) result.push({ name: edit.name, value: edit.value });
  }
  return result;
}

export interface WireResponse {
  headers: WireHeader[];
  body: string;
}

const contentType = (headers: WireHeader[]): string =>
  headers.find((h) => h.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";

function rewriteBody(rule: WireRule, body: string, type: string): string {
  if (rule.action === "json" && rule.json && /json/.test(type)) {
    try {
      return JSON.stringify(applyJsonOps(JSON.parse(body), rule.json));
    } catch {
      return body;
    }
  }
  if (rule.action === "html" && rule.html && /html/.test(type))
    return applyHtmlOps(body, rule.html);
  return body;
}

/** Runs every matching response rule in order; undefined when the response stays as it was. */
export function rewriteResponse(
  rules: WireRule[],
  response: WireResponse,
): WireResponse | undefined {
  if (!rules.length || response.body.length > MAX_BODY) return undefined;
  let { headers, body } = response;
  for (const rule of rules) {
    if (rule.action === "headers" && rule.headers)
      headers = applyHeaderEdits(headers, rule.headers);
    else body = rewriteBody(rule, body, contentType(headers));
  }
  if (body === response.body && headers === response.headers) return undefined;
  // The body changed length and encoding: the browser recomputes both.
  headers = headers.filter((h) => !/^(content-length|content-encoding)$/i.test(h.name));
  return { headers, body };
}
