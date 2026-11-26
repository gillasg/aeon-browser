import type { Operation, Signing } from "../types.js";
import type { Member } from "./operations.js";

// Finds request signatures: values that change on every call, come from no response, cookie
// or storage, and look like hashes. Records which script built the request, so calls can go
// through the site's own code (its fetch or XMLHttpRequest hooks sign them).

const SIGN_NAME =
  /(sign|signature|sig$|hmac|digest|x-s$|x-t$|x-bogus|_signature|mstoken|x-gorgon|x-khronos|x-argus|x-ladon|x-tt-params|x-request-sign|x-sign|nonce|x-client-data|anti-?content|x-zse-96)/i;
const ENTROPY = /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9+/=_.:-]{16,}$/;

function untraced(operation: Operation, target: string): boolean {
  const dep = operation.dependencies.find((d) => d.target === target);
  return !dep || (dep.source.kind === "generated" && dep.source.generator === "nonce");
}

function varies(values: string[]): boolean {
  return values.length < 2 || new Set(values).size === values.length;
}

/** Query names sites use for per-call challenge and signing tokens. */
const TOKEN_QUERY =
  /^(chal_t|challenge|sig|_sig|sign|signature|token|nonce|h|ts|csrf|_csrf|auth_token|_token|hmac|x-bogus|msToken|_signature)$/i;
/** Query names that change per call for ordinary reasons: paging, search, sorting, ids. */
const PLAIN_QUERY =
  /^(cursor|after|before|next|prev|page|page_?token|offset|start|limit|count|size|per_?page|q|query|search|term|keywords?|sort|order|filter|lang|locale|id|ids|callback|_|cb|v|ver|version)$/i;

function queryTokens(operation: Operation, members: Member[]): string[] {
  const names = operation.params.filter((p) => p.in === "query").map((p) => p.name);
  return names.filter((name) => {
    if (PLAIN_QUERY.test(name) || !untraced(operation, `query:${name}`)) return false;
    const values = members
      .map((m) => new URL(m.exchange.url).searchParams.get(name))
      .filter((v): v is string => !!v);
    if (!values.length) return false;
    const hashLike = values.every((v) => ENTROPY.test(v));
    const fresh = values.length >= 2 && varies(values);
    if (TOKEN_QUERY.test(name)) return hashLike || fresh;
    return hashLike && fresh;
  });
}

/** A script's path without host-specific query or content hashes: stable across rebuilds. */
export function stableModule(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const path = parsed.pathname
    .split("/")
    .map((part) =>
      part.replace(/[.-](?:[0-9a-f]{8,}|(?=[0-9a-f]*\d)[0-9a-f]{6,7})(?=\.(?:m|c)?js$)/i, ""),
    )
    .join("/");
  return parsed.host + path;
}

function signedNames(
  operation: Operation,
  members: Member[],
  location: "header" | "query",
): string[] {
  const names = operation.params.filter((p) => p.in === location).map((p) => p.name);
  return names.filter((name) => {
    const values = members
      .map((m) =>
        location === "header"
          ? m.exchange.requestHeaders[name]
          : new URL(m.exchange.url).searchParams.get(name),
      )
      .filter((v): v is string => !!v);
    if (!values.length || !untraced(operation, `${location}:${name}`)) return false;
    const hashLike = values.every((v) => ENTROPY.test(v));
    return (
      (SIGN_NAME.test(name) && hashLike) ||
      (hashLike && varies(values) && members.length >= 2 && /^x-/i.test(name))
    );
  });
}

const LIBRARY =
  /(jquery|axios|polyfill|zone\.js|sentry|datadog|newrelic|bugsnag|framework|vendor)/i;

export function detectSigning(operation: Operation, members: Member[]): Signing | undefined {
  const headers = signedNames(operation, members, "header");
  const query = [
    ...new Set([...signedNames(operation, members, "query"), ...queryTokens(operation, members)]),
  ];
  if (!headers.length && !query.length) return undefined;
  const stack =
    members.find((m) => m.exchange.initiator?.stack?.length)?.exchange.initiator?.stack ?? [];
  const frame = stack.find((f) => f.url && !LIBRARY.test(f.url)) ?? stack[0];
  const viaXhr = stack.some((f) => /XMLHttpRequest|\.send$|^send$/.test(f.functionName));
  const signing: Signing = {
    headers,
    query,
    tokens: [
      ...headers.map((param) => ({ in: "header" as const, param })),
      ...query.map((param) => ({ in: "query" as const, param })),
    ],
    via: viaXhr ? "xhr" : "fetch",
  };
  if (frame) {
    signing.initiator = { url: frame.url, functionName: frame.functionName, line: frame.line };
    const module = stableModule(frame.url);
    if (module) signing.initiator.module = module;
  }
  return signing;
}

/** Headers the page's own request code sets and a caller could not know: its version, clock and nonce. */
const PAGE_SUPPLIED =
  /^x-(cv|client-version|app-version|version|ts|timestamp|nonce|request-id|req-id|trace-id|correlation-id)$/i;

/**
 * Marks the signature parameters as derived: the page's own code fills them, so nothing offers
 * them as inputs (a caller can never compute a signature the site's key produced). A signed
 * operation's request is built in the page, so the page's own version and clock headers are
 * derived too: they arrive with the signature, not from the caller.
 */
export function markSignedParams(operation: Operation): void {
  const signing = operation.signing;
  if (!signing) return;
  for (const param of operation.params) {
    const signed =
      (param.in === "header" && signing.headers.includes(param.name)) ||
      (param.in === "query" && signing.query.includes(param.name)) ||
      (param.in === "header" && PAGE_SUPPLIED.test(param.name));
    if (signed) param.derived = "signer";
  }
}
