// Bundle-powered repair of a drifted operation. A call that fails the way a rotated endpoint fails
// (404, 410, 400, 422, PersistedQueryNotFound) re-reads the site's JS bundles, looks for the same
// operation under its new hash or path, and rebinds it with no model turn. A match must be clear,
// on the same site, and win alone; anything less declines and leaves the operation untouched.

import type { BundleCandidate, BundleGraph } from "./bundle-graph.js";
import type { Operation } from "./types.js";

export type BundleHealKind = "graphql_hash" | "rest_path" | "query_param";

export interface BundleRebind {
  kind: BundleHealKind;
  oldTarget: string;
  newTarget: string;
  confidence: number;
  path: string;
  hash?: string;
}

export interface BundleHealReceipt {
  operation: string;
  oldTarget: string;
  newTarget: string;
  kind: BundleHealKind;
  durationMs: number;
  confidence: number;
  zeroModelTurns: true;
}

export type RebindProposal = { rebind: BundleRebind } | { declined: string };

export const BUNDLE_HEAL_THRESHOLD = 0.7;
const AMBIGUITY_GAP = 0.1;
const HEALABLE_STATUS = /answered HTTP (400|404|410|422)\b/;
const HEALABLE_TEXT =
  /PersistedQueryNotFound|PERSISTED_QUERY_NOT_FOUND|persisted ?query not found/i;
const HASH_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

const HEALABLE_CODE =
  /^(PERSISTED_QUERY_NOT_FOUND|ENDPOINT_MOVED|OP_NOT_FOUND|HTTP_(400|404|410|422))$/;
const UNHEALABLE_CODE = /^(SITE_BLOCKED|RATE_LIMITED|SIGNED_OUT|AUTH_REQUIRED|HTTP_(401|403|429))$/;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function codeVerdict(code: string | undefined): boolean | undefined {
  if (!code) return undefined;
  if (UNHEALABLE_CODE.test(code)) return false;
  return HEALABLE_CODE.test(code) ? true : undefined;
}

/** A failure that looks like a moved endpoint or a rotated query hash, not a bot wall or auth. */
export function isHealableFailure(error: unknown): boolean {
  // The error's code decides first; the message text is the fallback for errors without one.
  const byCode = codeVerdict(errorCode(error));
  if (byCode !== undefined) return byCode;
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/SITE_BLOCKED|RATE_LIMITED|answered HTTP (401|403|429)\b/.test(text)) return false;
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === "number" && [400, 404, 410, 422].includes(status)) return true;
  return HEALABLE_STATUS.test(text) || HEALABLE_TEXT.test(text);
}

/** A result that carries a persisted-query miss in its GraphQL errors (often with HTTP 200). */
export function isPersistedQueryMiss(result: unknown): boolean {
  const errors = (result as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) && HEALABLE_TEXT.test(JSON.stringify(errors));
}

/** Only reads are retried by default: GET/HEAD, a GraphQL query, or an operation marked read. */
export function safeToReplay(op: Operation): boolean {
  if (op.effect) return op.effect === "read";
  if (op.role === "action" || op.role === "auth") return false;
  if (/^(GET|HEAD)$/i.test(op.method)) return true;
  if (op.kind !== "graphql") return false;
  return !/^\s*mutation\b/.test(op.graphql?.query ?? "");
}

function graphqlName(op: Operation): string | undefined {
  return op.graphql?.operationName ?? op.match?.graphql?.operationName;
}

function persisted(op: Operation): string | undefined {
  const ext = op.graphql?.extensions as { persistedQuery?: { sha256Hash?: unknown } } | undefined;
  const value = ext?.persistedQuery?.sha256Hash;
  return typeof value === "string" ? value : undefined;
}

function oldHash(op: Operation): string | undefined {
  return op.graphql?.hash ?? op.match?.graphql?.hash ?? persisted(op);
}

function segments(path: string): string[] {
  return (path.split("?")[0] ?? "").split("/").filter(Boolean);
}

function shape(segment: string): string {
  return /^\{.*\}$/.test(segment) || segment === "EXPR" ? "{}" : segment;
}

/** Same host, or a subdomain of the same registrable name (api.a.com for www.a.com). */
export function trustedOrigin(opOrigin: string, url: string | undefined): boolean {
  if (!url || url.startsWith("/")) return true;
  try {
    const want = new URL(opOrigin).hostname;
    const got = new URL(url.replaceAll("EXPR", "x")).hostname;
    return got === want || root(got) === root(want);
  } catch {
    return false;
  }
}

function root(host: string): string {
  return host.split(".").slice(-2).join(".");
}

function candidatePath(candidate: BundleCandidate): string | undefined {
  const raw = candidate.template ?? candidate.url;
  if (!raw) return undefined;
  if (raw.startsWith("/")) return raw.split("?")[0];
  try {
    return new URL(raw.replaceAll("EXPR", "x")).pathname.replace(/\/x(?=\/|$)/g, "/{param}");
  } catch {
    return undefined;
  }
}

interface Scored {
  rebind: BundleRebind;
}

function pick(scored: Scored[], what: string): RebindProposal {
  const distinct = new Map<string, Scored>();
  for (const item of scored) {
    const seen = distinct.get(item.rebind.newTarget);
    if (!seen || seen.rebind.confidence < item.rebind.confidence)
      distinct.set(item.rebind.newTarget, item);
  }
  const ranked = [...distinct.values()].sort((a, b) => b.rebind.confidence - a.rebind.confidence);
  const [best, next] = ranked;
  if (!best || best.rebind.confidence < BUNDLE_HEAL_THRESHOLD)
    return { declined: `no confident ${what} in the bundles` };
  if (next && best.rebind.confidence - next.rebind.confidence < AMBIGUITY_GAP)
    return { declined: `ambiguous ${what}: ${ranked.length} candidates` };
  return { rebind: best.rebind };
}

/** A path segment's value: itself, or the recorded constant of the param it templates. */
function segmentValue(op: Operation, segment: string | undefined): string | undefined {
  const param = /^\{(.+)\}$/.exec(segment ?? "")?.[1];
  if (!param) return segment;
  return op.params.find((p) => p.in === "path" && p.name === param)?.constant;
}

/** The persisted hash next to the operation name, before it (/<hash>/Name) or after (/Name/<hash>). */
function hashFromPath(op: Operation, name: string): { index: number; hash: string } | undefined {
  const parts = segments(op.path);
  const at = parts.lastIndexOf(name);
  if (at < 0) return undefined;
  for (const index of [at + 1, at - 1]) {
    const hash = index >= 0 ? segmentValue(op, parts[index]) : undefined;
    if (hash && HASH_SEGMENT.test(hash)) return { index, hash };
  }
  return undefined;
}

function graphqlRebinds(op: Operation, graph: BundleGraph, name: string): Scored[] {
  const old = oldHash(op);
  const inPath = hashFromPath(op, name);
  const out: Scored[] = [];
  for (const candidate of graph.candidates) {
    if (!trustedOrigin(op.origin, candidate.url)) continue;
    const named = candidate.operationName === name ? candidate.sha256 : undefined;
    const found = named ?? (inPath && hashInCandidate(op, candidate, inPath.index));
    if (!found || found === old || found === inPath?.hash) continue;
    out.push({ rebind: hashRebind(op, name, found, inPath, named ? 0.95 : 0.9, old) });
  }
  return out;
}

function hashRebind(
  op: Operation,
  name: string,
  hash: string,
  inPath: { index: number; hash: string } | undefined,
  confidence: number,
  old: string | undefined,
): BundleRebind {
  return {
    kind: "graphql_hash",
    oldTarget: `${name}@${inPath?.hash ?? old ?? "?"}`,
    newTarget: `${name}@${hash}`,
    confidence,
    path: inPath ? replaceSegment(op.path, inPath.index, hash) : op.path,
    hash,
  };
}

function hashInCandidate(
  op: Operation,
  candidate: BundleCandidate,
  index: number,
): string | undefined {
  const path = candidatePath(candidate);
  if (!path) return undefined;
  const mine = segments(op.path);
  const theirs = segments(path);
  if (theirs.length !== mine.length) return undefined;
  const same = mine.every((part, i) => i === index || shape(part) === shape(theirs[i] ?? ""));
  const hash = theirs[index];
  return same && hash && HASH_SEGMENT.test(hash) ? hash : undefined;
}

function replaceSegment(path: string, index: number, value: string): string {
  const parts = segments(path);
  parts[index] = value;
  return `/${parts.join("/")}`;
}

function methodFits(op: Operation, candidate: BundleCandidate): boolean {
  return (candidate.method ?? "GET").toUpperCase() === op.method.toUpperCase();
}

/** How close a bundle path is to the drifted one: one renamed segment, or a moved prefix. */
export function pathScore(oldPath: string, newPath: string): number {
  const a = segments(oldPath).map(shape);
  const b = segments(newPath).map(shape);
  if (a.join("/") === b.join("/")) return 0;
  if (a.length === b.length) return renamedScore(a, b);
  return prefixScore(a, b);
}

function renamedScore(a: string[], b: string[]): number {
  const diff = a.flatMap((part, i) => (part === b[i] ? [] : [i]));
  if (diff.length !== 1) return 0;
  const i = diff[0] ?? 0;
  const [from = "{}", to = "{}"] = [a[i], b[i]];
  if (from === "{}" || to === "{}") return 0;
  if (/^v\d+$/i.test(from) && /^v\d+$/i.test(to)) return 0.92;
  const literals = a.filter((part, j) => j !== i && part !== "{}").length;
  return literals >= 2 ? 0.75 : 0.5;
}

function prefixScore(a: string[], b: string[]): number {
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  const tail = long.slice(long.length - short.length);
  if (short.length < 2 || tail.join("/") !== short.join("/")) return 0;
  return short.filter((part) => part !== "{}").length >= 2 ? 0.72 : 0.5;
}

function restRebinds(op: Operation, graph: BundleGraph): Scored[] {
  const out: Scored[] = [];
  for (const candidate of graph.candidates) {
    if (candidate.kind !== "api" || !methodFits(op, candidate)) continue;
    if (!trustedOrigin(op.origin, candidate.url)) continue;
    const path = candidatePath(candidate);
    if (!path) continue;
    const confidence = pathScore(op.path, path);
    if (!confidence) continue;
    const rebound = keepNames(op.path, path);
    out.push({
      rebind: {
        kind: "rest_path",
        oldTarget: `${op.method} ${op.path}`,
        newTarget: `${op.method} ${rebound}`,
        confidence,
        path: rebound,
      },
    });
  }
  return out;
}

/** The new path with the operation's own parameter names put back in, in order. */
function keepNames(oldPath: string, newPath: string): string {
  const names = segments(oldPath).filter((part) => /^\{.*\}$/.test(part));
  let i = 0;
  const parts = segments(newPath).map((part) =>
    shape(part) === "{}" ? (names[i++] ?? part) : part,
  );
  return `/${parts.join("/")}`;
}

/** Proposes one rebind for a drifted operation from a bundle read, or says why it declined. */
export function proposeRebind(op: Operation, graph: BundleGraph): RebindProposal {
  const name = graphqlName(op);
  if (op.kind === "graphql" && name) return pick(graphqlRebinds(op, graph, name), "query hash");
  if (op.kind === "graphql") return { declined: "GraphQL operation has no name to match" };
  if (op.kind !== "rest") return { declined: `${op.kind} operations are not rebound` };
  return pick(restRebinds(op, graph), "endpoint path");
}

/** A copy of the operation pointed at the new hash or path. */
/** A persisted-hash path param carries the new hash too. */
function rehashParams(op: Operation, hash: string, old: string | undefined): void {
  for (const param of op.params) {
    if (param.persistedHash) param.constant = hash;
    else if (old) {
      // The hash inside a query value too: extensions={"persistedQuery":{"sha256Hash":"…"}}.
      if (param.constant?.includes(old)) param.constant = param.constant.split(old).join(hash);
      if (param.default?.includes(old)) param.default = param.default.split(old).join(hash);
    }
  }
}

export function applyRebind(op: Operation, rebind: BundleRebind): Operation {
  const next = structuredClone(op);
  next.path = rebind.path;
  if (rebind.kind !== "graphql_hash" || !rebind.hash) return next;
  const hash = rebind.hash;
  const old = oldHash(op) ?? /@(.+)$/.exec(rebind.oldTarget)?.[1];
  // The hash wherever it appears: a path segment, extensions.persistedQuery, query values.
  if (old && old !== "?") next.path = next.path.split(old).join(hash);
  rehashGraphql(next, op, hash);
  rehashParams(next, hash, old);
  return next;
}

function rehashGraphql(next: Operation, op: Operation, hash: string): void {
  if (next.graphql) {
    if (next.graphql.hash !== undefined || !persisted(op)) next.graphql.hash = hash;
    const ext = next.graphql.extensions as { persistedQuery?: Record<string, unknown> } | undefined;
    if (ext?.persistedQuery) ext.persistedQuery.sha256Hash = hash;
  }
  if (next.match?.graphql?.hash) next.match.graphql.hash = hash;
}
