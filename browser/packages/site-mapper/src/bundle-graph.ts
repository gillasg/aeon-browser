import { parse } from "acorn";
import {
  collapse,
  constants,
  EXPR,
  isNode,
  maybeUrl,
  memberPath,
  objectKeys,
  property,
  propertyName,
  toTemplate,
  walk,
  type Node,
} from "./bundle-strings.js";

// A static read of a site's JS bundles: the API calls, navigations, GraphQL operations, route
// tables, chunk edges, feature-flag keys and config blobs written in the code, found by walking
// its syntax tree in the daemon. Nothing runs in the page and no debugger is attached. Every
// finding is a hypothesis (provenance "static") until real traffic confirms it.

export type CandidateKind = "api" | "navigation" | "graphql" | "route";

export interface BundleCandidate {
  kind: CandidateKind;
  /** Where it came from: fetch, xhr, axios, jquery, new URL, location, gql, route-table… */
  sink: string;
  method?: string;
  /** The collapsed string as written, EXPR for unknown parts. */
  url?: string;
  template?: string;
  query?: string[];
  headers?: string[];
  bodyKeys?: string[];
  operationName?: string;
  operationType?: string;
  sha256?: string;
  file: string;
  line: number;
  offset: number;
  provenance: "static" | "observed";
  confirmed: boolean;
}

export interface BundleGraph {
  summary: string;
  candidates: BundleCandidate[];
  chunks: { from: string; to: string }[];
  flags: string[];
  configs: { name: string; keys: string[]; file: string }[];
  queryParams: string[];
  notes: string[];
}

const MAX_CANDIDATES = 400;
const MAX_FILE = 6_000_000;
const PREFILTER =
  /["'`]\/[\w{$:[-]|https?:\/\/|fetch\(|\.open\(|axios|ajax|\$\.(get|post)|new URL|gql|graphql|sha256Hash|import\(|__BUILD_MANIFEST|path\s*:|location|URLSearchParams|[Ff]lag|[Cc]onfig/;
const HTTP_VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;
const FLAG_CALLS =
  /^(useFlag|useFeatureFlag|getFeatureFlag|isFeatureEnabled|isEnabled|getFlag|checkGate|useGate|variation|boolVariation|isOn|featureEnabled)$/;

interface Ctx {
  file: string;
  names: Map<string, string>;
  out: BundleCandidate[];
  chunks: BundleGraph["chunks"];
  flags: Set<string>;
  configs: BundleGraph["configs"];
  queryParams: Set<string>;
  xhr: Map<string, BundleCandidate>;
}

/** Cheap check before parsing: does the text hold anything a sink could match? */
export function worthParsing(text: string): boolean {
  return text.length > 0 && text.length <= MAX_FILE && PREFILTER.test(text);
}

export function parseBundle(text: string): Node | undefined {
  const base = { ecmaVersion: "latest", locations: true, allowHashBang: true } as const;
  for (const sourceType of ["module", "script"] as const) {
    try {
      return parse(text, {
        ...base,
        sourceType,
        allowReturnOutsideFunction: sourceType === "script",
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
      }) as unknown as Node;
    } catch {
      // try the other source type
    }
  }
  return undefined;
}

/** Analyses several files into one graph. */
export function analyzeBundles(files: Iterable<readonly [string, string]>): BundleGraph {
  const graph = emptyGraph();
  for (const [file, text] of files) {
    if (graph.candidates.length >= MAX_CANDIDATES) {
      graph.notes.push("stopped after the candidate cap");
      break;
    }
    mergeGraph(graph, analyzeBundle(file, text));
  }
  graph.candidates = dedupe(graph.candidates).slice(0, MAX_CANDIDATES);
  graph.summary = summarize(graph);
  return graph;
}

/** Analyses one file. A file that fails the pre-filter or does not parse yields an empty graph. */
export function analyzeBundle(file: string, text: string): BundleGraph {
  const graph = emptyGraph();
  if (!worthParsing(text)) return graph;
  const root = parseBundle(text);
  if (!root) {
    graph.notes.push(`could not parse ${file}`);
    return graph;
  }
  const ctx: Ctx = {
    file,
    names: constants(root),
    out: graph.candidates,
    chunks: graph.chunks,
    flags: new Set(),
    configs: graph.configs,
    queryParams: new Set(),
    xhr: new Map(),
  };
  walk(root, (node, parent) => visit(ctx, node, parent));
  graph.flags = [...ctx.flags];
  graph.queryParams = [...ctx.queryParams];
  graph.candidates = dedupe(graph.candidates);
  graph.summary = summarize(graph);
  return graph;
}

function visit(ctx: Ctx, node: Node, parent: Node | undefined): void {
  switch (node.type) {
    case "CallExpression":
      return onCall(ctx, node);
    case "NewExpression":
      return onNew(ctx, node);
    case "AssignmentExpression":
      return onAssign(ctx, node);
    case "TaggedTemplateExpression":
      return onTagged(ctx, node);
    case "ObjectExpression":
      return onObject(ctx, node);
    case "ImportExpression":
      return chunkEdge(ctx, collapse(node.source, ctx.names));
    case "Literal":
      if (parent?.type !== "ImportExpression" && typeof node.value === "string")
        chunkString(ctx, node.value);
      return;
    default:
      return;
  }
}

function add(
  ctx: Ctx,
  node: Node,
  item: Omit<BundleCandidate, "file" | "line" | "offset" | "provenance" | "confirmed">,
): BundleCandidate {
  const candidate: BundleCandidate = {
    ...item,
    file: ctx.file,
    line: node.loc?.start.line ?? 0,
    offset: node.start,
    provenance: "static",
    confirmed: false,
  };
  ctx.out.push(candidate);
  return candidate;
}

function urlFields(value: string): Pick<BundleCandidate, "url" | "template" | "query"> {
  const { template, query } = toTemplate(value);
  return { url: value, template, ...(query.length ? { query } : {}) };
}

function addUrl(
  ctx: Ctx,
  node: Node,
  sink: string,
  urlNode: unknown,
  extra: Partial<BundleCandidate> = {},
): BundleCandidate | undefined {
  const value = collapse(urlNode, ctx.names);
  if (!value || !maybeUrl(value)) return undefined;
  return add(ctx, node, { kind: "api", sink, ...urlFields(value), ...extra });
}

type CallHandler = (ctx: Ctx, node: Node, callee: string, args: Node[]) => void;

const CALLS: [(callee: string, args: Node[]) => boolean, CallHandler][] = [
  [
    (callee) => /^(window\.|globalThis\.|self\.)?fetch$/.test(callee),
    (ctx, node, _c, args) => void onFetch(ctx, node, args),
  ],
  [
    (callee) => /^(axios|\w+\.axios)(\.(request|get|post|put|patch|delete|head))?$/.test(callee),
    onAxios,
  ],
  [(callee) => /^(\$|jQuery)\.(get|post|getJSON|ajax)$/.test(callee), onJquery],
  [
    (callee, args) => callee.endsWith(".open") && args.length >= 2 && isMethodLiteral(args[0]),
    onXhrOpen,
  ],
  [
    (callee) => callee.endsWith(".setRequestHeader"),
    (ctx, _n, callee, args) => onXhrHeader(ctx, callee, args),
  ],
  [
    isNavigationCall,
    (ctx, node, callee, args) =>
      void navigation(ctx, node, callee, /^history\./.test(callee) ? args[2] : args[0]),
  ],
  [
    (callee) => FLAG_CALLS.test(callee.split(".").pop() ?? ""),
    (ctx, _n, _c, args) => flagKey(ctx, args[0]),
  ],
];

function onCall(ctx: Ctx, node: Node): void {
  const callee = memberPath(node.callee) ?? "";
  if (!callee) return;
  const args = (node.arguments as Node[]) ?? [];
  const handler = CALLS.find(([test]) => test(callee, args))?.[1];
  handler?.(ctx, node, callee, args);
}

function isMethodLiteral(node: unknown): boolean {
  return (
    isNode(node) &&
    node.type === "Literal" &&
    typeof node.value === "string" &&
    HTTP_VERB.test(node.value)
  );
}

function literal(node: unknown): string | undefined {
  return isNode(node) && node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

function headerKeys(node: unknown): string[] {
  if (isNode(node) && node.type === "NewExpression" && memberPath(node.callee) === "Headers")
    return objectKeys((node.arguments as Node[])[0]);
  return objectKeys(node);
}

function bodyKeys(node: unknown): string[] {
  if (
    isNode(node) &&
    node.type === "CallExpression" &&
    memberPath(node.callee) === "JSON.stringify"
  )
    return objectKeys((node.arguments as Node[])[0]);
  return objectKeys(node);
}

function requestInit(init: unknown, methodKey = "method"): Partial<BundleCandidate> {
  const method = literal(property(init, methodKey)) ?? literal(property(init, "type"));
  const headers = headerKeys(property(init, "headers"));
  const body = bodyKeys(property(init, "body") ?? property(init, "data"));
  return {
    ...(method ? { method: method.toUpperCase() } : {}),
    ...(headers.length ? { headers } : {}),
    ...(body.length ? { bodyKeys: body } : {}),
  };
}

function onFetch(ctx: Ctx, node: Node, args: Node[]): BundleCandidate | undefined {
  const init = requestInit(args[1]);
  return addUrl(ctx, node, "fetch", args[0], { method: "GET", ...init });
}

function onAxios(ctx: Ctx, node: Node, callee: string, args: Node[]): void {
  const verb = /\.(get|post|put|patch|delete|head)$/.exec(callee)?.[1];
  if (verb) {
    const config = verb === "get" || verb === "delete" || verb === "head" ? args[1] : args[2];
    addUrl(ctx, node, "axios", args[0], { method: verb.toUpperCase(), ...requestInit(config) });
    return;
  }
  const config = args[0]?.type === "ObjectExpression" ? args[0] : args[1];
  const url = args[0]?.type === "ObjectExpression" ? property(args[0], "url") : args[0];
  addUrl(ctx, node, "axios", url, { method: "GET", ...requestInit(config) });
}

function onJquery(ctx: Ctx, node: Node, callee: string, args: Node[]): void {
  const verb = callee.split(".").pop() ?? "";
  if (verb !== "ajax") {
    addUrl(ctx, node, "jquery", args[0], {
      method: verb === "post" ? "POST" : "GET",
      ...requestInit(args[1] ?? undefined),
    });
    return;
  }
  const settings = args[0]?.type === "ObjectExpression" ? args[0] : args[1];
  const url = args[0]?.type === "ObjectExpression" ? property(args[0], "url") : args[0];
  addUrl(ctx, node, "jquery", url, { method: "GET", ...requestInit(settings) });
}

function onXhrOpen(ctx: Ctx, node: Node, callee: string, args: Node[]): void {
  const object = callee.slice(0, -".open".length);
  const method = (literal(args[0]) ?? "GET").toUpperCase();
  const found = addUrl(ctx, node, "xhr", args[1], { method });
  if (found) ctx.xhr.set(object, found);
}

function onXhrHeader(ctx: Ctx, callee: string, args: Node[]): void {
  const open = ctx.xhr.get(callee.slice(0, -".setRequestHeader".length));
  const name = literal(args[0]);
  if (!open || !name) return;
  open.headers = [...new Set([...(open.headers ?? []), name])];
}

function isNavigationCall(callee: string): boolean {
  return /^((window|document|globalThis|self)\.)?location\.(assign|replace)$|^window\.open$|^history\.(push|replace)State$|^(router|this\.router|\w+\.router)\.(push|replace|navigate)$|^navigate$/.test(
    callee,
  );
}

function navigation(
  ctx: Ctx,
  node: Node,
  sink: string,
  target: unknown,
): BundleCandidate | undefined {
  const value = collapse(target, ctx.names);
  if (!value || !maybeUrl(value)) return undefined;
  return add(ctx, node, { kind: "navigation", sink, ...urlFields(value) });
}

function onAssign(ctx: Ctx, node: Node): void {
  const left = memberPath(node.left) ?? "";
  if (
    /^((window|document|globalThis|self)\.)?location(\.href|\.pathname)?$/.test(left) &&
    left.includes("location")
  )
    return void navigation(ctx, node, left, node.right);
  const right = node.right as Node;
  const name = left.split(".").pop() ?? "";
  if (!/^(window|self|globalThis)\./.test(left) || right?.type !== "ObjectExpression") return;
  if (name === "__BUILD_MANIFEST") return buildManifest(ctx, node, right);
  if (/^__[A-Z0-9_]+__$|config|env|settings/i.test(name))
    ctx.configs.push({ name: left, keys: objectKeys(right).slice(0, 100), file: ctx.file });
}

function buildManifest(ctx: Ctx, node: Node, manifest: Node): void {
  for (const prop of manifest.properties as Node[]) {
    const route = propertyName(prop);
    if (!route?.startsWith("/")) continue;
    add(ctx, node, { kind: "route", sink: "build-manifest", ...urlFields(route) });
    const value = prop.value as Node;
    if (value?.type === "ArrayExpression")
      for (const item of value.elements as Node[])
        chunkEdge(ctx, literal(item), manifestBase(ctx.file));
  }
}

function onNew(ctx: Ctx, node: Node): void {
  const callee = memberPath(node.callee);
  const args = (node.arguments as Node[]) ?? [];
  if (callee === "URL") {
    const base = collapse(args[1], ctx.names);
    const path = collapse(args[0], ctx.names);
    if (path && base && !path.includes("://") && maybeUrl(path))
      return void add(ctx, node, { kind: "api", sink: "new URL", ...urlFields(path) });
    return void addUrl(ctx, node, "new URL", args[0]);
  }
  if (callee === "URLSearchParams") for (const key of objectKeys(args[0])) ctx.queryParams.add(key);
}

function onTagged(ctx: Ctx, node: Node): void {
  const tag = memberPath(node.tag) ?? "";
  if (!/^(gql|graphql)$|\.(gql|graphql)$/.test(tag)) return;
  const quasi = node.quasi as Node;
  const text = (quasi.quasis as Node[])
    .map((part) => String((part.value as { cooked?: string }).cooked ?? ""))
    .join(" ");
  graphqlOperation(ctx, node, "gql", text);
}

function graphqlOperation(
  ctx: Ctx,
  node: Node,
  sink: string,
  text: string,
  extra: Partial<BundleCandidate> = {},
): void {
  const found = /\b(query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(text);
  if (!found && !/^\s*(fragment|\{)/.test(text)) return;
  if (/^\s*fragment\b/.test(text)) return;
  add(ctx, node, {
    kind: "graphql",
    sink,
    method: "POST",
    operationType: found?.[1] ?? "query",
    ...(found?.[2] ? { operationName: found[2] } : {}),
    ...extra,
  });
}

function onObject(ctx: Ctx, node: Node): void {
  routeEntry(ctx, node);
  graphqlObject(ctx, node);
  for (const key of objectKeys(node))
    if (/^(featureFlags|flags|features|experiments|gates)$/.test(key))
      for (const flag of objectKeys(property(node, key))) ctx.flags.add(flag);
}

function routeEntry(ctx: Ctx, node: Node): void {
  const path = literal(property(node, "path"));
  if (!path?.startsWith("/")) return;
  const routeKey = /^(component|element|loader|children|name|lazy|redirect|meta|exact)$/;
  if (objectKeys(node).some((key) => routeKey.test(key)))
    add(ctx, node, { kind: "route", sink: "route-table", ...urlFields(path) });
}

function graphqlObject(ctx: Ctx, node: Node): void {
  const query = literal(property(node, "query"));
  const operationName = literal(property(node, "operationName"));
  const named = operationName ? { operationName } : {};
  if (query && /\b(query|mutation|subscription)\b|^\s*\{/.test(query))
    graphqlOperation(ctx, node, "graphql-body", query, named);
  const hash =
    literal(property(node, "sha256Hash")) ?? (operationName ? nestedHash(node) : undefined);
  if (hash && /^[0-9a-f]{64}$/i.test(hash))
    add(ctx, node, {
      kind: "graphql",
      sink: "persisted-query",
      method: "GET",
      sha256: hash,
      ...named,
    });
}

/** `{operationName, extensions: {persistedQuery: {sha256Hash}}}`: the hash named by its operation. */
function nestedHash(node: Node): string | undefined {
  const persisted = property(property(node, "extensions"), "persistedQuery");
  return literal(property(persisted, "sha256Hash"));
}

function flagKey(ctx: Ctx, node: unknown): void {
  const key = literal(node);
  if (key && key.length <= 80 && /^[\w.:-]+$/.test(key)) ctx.flags.add(key);
}

function chunkString(ctx: Ctx, value: string): void {
  if (
    /^(\.{0,2}\/)?([\w.-]+\/)*(chunks|assets|static|_next|_nuxt|build)\/[\w./-]+\.(m?js|css)(\?\S*)?$/.test(
      value,
    )
  )
    chunkEdge(ctx, value);
}

/** Next.js manifest chunk paths are relative to its /_next/ root, not to the manifest file. */
function manifestBase(file: string): string | undefined {
  if (!file.includes("://")) return undefined;
  return new URL(file.includes("/_next/") ? "/_next/" : "/", file).href;
}

function chunkEdge(ctx: Ctx, value: string | undefined, base?: string): void {
  if (
    !value ||
    value.includes(EXPR) ||
    !/\.(m?js|css)(\?|$)/.test(value) ||
    ctx.chunks.length >= 500
  )
    return;
  let to = value;
  try {
    to = new URL(value, base ?? (ctx.file.includes("://") ? ctx.file : undefined)).href;
  } catch {
    // keep it relative
  }
  if (!ctx.chunks.some((edge) => edge.to === to)) ctx.chunks.push({ from: ctx.file, to });
}

function emptyGraph(): BundleGraph {
  return {
    summary: "",
    candidates: [],
    chunks: [],
    flags: [],
    configs: [],
    queryParams: [],
    notes: [],
  };
}

function mergeGraph(into: BundleGraph, from: BundleGraph): void {
  into.candidates.push(...from.candidates);
  into.chunks.push(...from.chunks);
  into.flags = [...new Set([...into.flags, ...from.flags])].slice(0, 300);
  into.configs.push(...from.configs);
  into.queryParams = [...new Set([...into.queryParams, ...from.queryParams])].slice(0, 300);
  into.notes.push(...from.notes);
}

function dedupe(list: BundleCandidate[]): BundleCandidate[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const key = [item.kind, item.method, item.template, item.operationName, item.sha256].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(graph: BundleGraph): string {
  const count = (kind: CandidateKind) =>
    graph.candidates.filter((item) => item.kind === kind).length;
  return `${count("api")} API calls, ${count("graphql")} GraphQL operations, ${count("navigation")} navigations, ${count("route")} routes, ${graph.chunks.length} chunk edges, ${graph.flags.length} flags (static, unconfirmed)`;
}

/** Marks candidates that real traffic has hit: same method (when known) and a matching path. */
export function confirmCandidates(
  graph: BundleGraph,
  observed: readonly { method?: string; url: string }[],
): BundleGraph {
  const seen = observed.map((item) => ({
    method: item.method?.toUpperCase(),
    path: pathOf(item.url),
    body: item.url,
  }));
  for (const candidate of graph.candidates) {
    if (!candidate.template || candidate.kind === "route") continue;
    const pattern = templatePattern(candidate.template);
    const hit = seen.some(
      (item) =>
        (!candidate.method || !item.method || item.method === candidate.method) &&
        pattern.test(
          candidate.template?.includes("://") ? (item.body.split("?")[0] ?? "") : item.path,
        ),
    );
    if (hit) Object.assign(candidate, { confirmed: true, provenance: "observed" });
  }
  return graph;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function templatePattern(template: string): RegExp {
  const escaped = template
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\\?\{[^}]+\\?\}/g, "[^/]+");
  return new RegExp(`^${escaped.replace(/\{[^}]*\}/g, "[^/]+")}/?$`);
}
