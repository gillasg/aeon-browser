// A call that repairs itself, shared by browser cells, the per-site MCP server and the shared
// site_mapper tool. The bundles are read inside the page the operation was learned on: script
// URLs come from the page's own resource timing and are fetched from the page with
// `cache: "force-cache"`, so the browser's HTTP cache answers and Node never fetches a bundle.

import { analyzeBundles, type BundleCandidate, type BundleGraph } from "./bundle-graph.js";
import { callWithBundleHeal, type BundleHealDeps } from "./bundle-heal-run.js";
import { proposeRebind } from "./bundle-heal.js";
import { loadCurrentModel } from "./model-refresh.js";
import { readOverrides, saveModel, siteHome } from "./registry.js";
import type { Params } from "./runtime/request.js";
import { siteMapper } from "./runtime/site-mapper.js";
import { PageTransport } from "./runtime/transports.js";
import type { Operation, SiteModel } from "./types.js";

const BUNDLE_FILES = 40;
const BUNDLE_BYTES = 4_000_000;
const BUNDLE_MS = 15_000;

/** The page an operation was learned on: its latest sample's page, or the site's home. */
export function opPageUrl(site: string, op: Operation): string {
  const samples = [...(op.samples ?? [])].reverse();
  // pageUrls lists the most common page first; a later call made from the home tab must not
  // replace the page the operation was learned on.
  const recorded = [
    ...(op.pageUrls ?? []),
    ...samples.map((sample) => sample.pageUrl),
    // A capture without page records still names the page in each request's referer.
    ...samples.map((sample) => headerValue(sample.requestHeaders, "referer")),
  ].find((url) => !!url && /^https?:\/\//i.test(url));
  if (recorded) return recorded;
  return op.origin ? `${op.origin.replace(/\/$/, "")}/` : siteHome(site);
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

/**
 * Runs in the page: the page's scripts (resource timing, then <script src>, then the scripts of
 * the recorded page when the tab sits elsewhere on the site), each read from the HTTP cache.
 */
export function bundleExpression(
  pageUrl: string,
  cache: "force-cache" | "no-cache" = "force-cache",
): string {
  return `(async () => {
  const page = ${JSON.stringify(pageUrl)};
  const deadline = Date.now() + ${BUNDLE_MS};
  const urls = new Set();
  const add = (u) => { try { const x = new URL(u, location.href); if (x.origin === location.origin) urls.add(x.href); } catch {} };
  for (const e of performance.getEntriesByType('resource')) if (e.initiatorType === 'script' || /\\.m?js(\\?|$)/.test(e.name)) add(e.name);
  for (const s of document.scripts) if (s.src) add(s.src);
  const here = location.href.split('#')[0];
  const inline = [...document.scripts].filter((s) => !s.src).map((s, i) => [here + '#inline-' + (i + 1), s.textContent || '']);
  if (here !== page) {
    try {
      const html = await (await fetch(page, { cache: ${JSON.stringify(cache)}, credentials: 'include' })).text();
      for (const m of html.matchAll(/<script\\b[^>]*\\bsrc=["']([^"']+)["']/gi)) add(new URL(m[1], page).href);
      [...html.matchAll(/<script\\b(?![^>]*\\bsrc=)[^>]*>([^]*?)<\\/script>/gi)].forEach((m, i) => inline.push([page + '#inline-' + (i + 1), m[1] || '']));
    } catch {}
  }
  const files = [];
  let bytes = 0;
  for (const url of [...urls].slice(0, ${BUNDLE_FILES})) {
    if (Date.now() > deadline || bytes > ${BUNDLE_BYTES}) break;
    try {
      const response = await fetch(url, { cache: ${JSON.stringify(cache)}, credentials: 'include' });
      if (!response.ok) continue;
      const text = await response.text();
      bytes += text.length;
      files.push([url, text.slice(0, ${BUNDLE_BYTES})]);
    } catch {}
  }
  return [...inline, ...files];
})()`;
}

/**
 * The bundles read inside the operation's page, or undefined when no browser is connected. The
 * HTTP cache answers first; when its copy holds no new target for the operation (the cached
 * bundle predates the deploy), the page reads them again with revalidation. Either way the
 * request comes from the page, never from Node.
 */
export async function pageBundle(
  site: string,
  op: Operation,
  page: Pick<PageTransport, "inPage"> = new PageTransport(),
): Promise<BundleGraph | undefined> {
  const url = opPageUrl(site, op);
  const cached = await readInPage(page, url, op, "force-cache");
  if (cached && !("declined" in proposeRebind(op, cached))) return cached;
  return (await readInPage(page, url, op, "no-cache")) ?? cached;
}

async function readInPage(
  page: Pick<PageTransport, "inPage">,
  url: string,
  op: Operation,
  cache: "force-cache" | "no-cache",
): Promise<BundleGraph | undefined> {
  const files = (await page.inPage(url, bundleExpression(url, cache), BUNDLE_MS + 10_000)) as
    [string, string][] | undefined;
  if (!Array.isArray(files) || !files.length) return undefined;
  const scripts = files.filter(([, text]) => !/^\s*</.test(text));
  const graph = analyzeBundles(scripts);
  graph.candidates.push(...namedHashes(op, scripts));
  return graph;
}

const SHA256 = /["'`]([a-f0-9]{64})["'`]/g;

function singleFreshHash(text: string, known: string): string | undefined {
  const found = new Set<string>();
  for (const match of text.matchAll(SHA256)) {
    const hash = match[1];
    if (hash && !known.includes(hash)) found.add(hash);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * A persisted hash kept in a constant (`const H = "…"; fetch('/gql/Name/' + H)`) is invisible
 * to the call-site reader. A file that names the operation and holds exactly one new 64-hex
 * literal names its new hash.
 */
export function namedHashes(op: Operation, files: readonly [string, string][]): BundleCandidate[] {
  const name = op.graphql?.operationName ?? op.match?.graphql?.operationName;
  if (op.kind !== "graphql" || !name) return [];
  const known = JSON.stringify([op.path, op.graphql ?? {}, op.match ?? {}]);
  const out: BundleCandidate[] = [];
  for (const [file, text] of files) {
    if (!text.includes(name)) continue;
    const sha256 = singleFreshHash(text, known);
    if (!sha256) continue;
    out.push({
      kind: "graphql",
      sink: "constant",
      operationName: name,
      sha256,
      file,
      line: 0,
      offset: text.indexOf(sha256),
      provenance: "static",
      confirmed: false,
    });
  }
  return out;
}

/** Bundle repair against the current model, the bundles in the page and the mapped runtime. */
export const liveHealDeps: BundleHealDeps = {
  loadModel: loadCurrentModel,
  saveModel: async (model: SiteModel) => saveModel(model, await readOverrides(model.site)),
  bundle: (site, op) => pageBundle(site, op),
  call: async (site, id, params, model) =>
    (await siteMapper(site, model ? { model } : {})).call(id, params as Params),
};

/** One call that, on a rotated hash or moved path, heals from the bundles and answers. */
export function healingCall(
  site: string,
  id: string,
  params: Record<string, unknown>,
  deps: BundleHealDeps = liveHealDeps,
): Promise<unknown> {
  return callWithBundleHeal(site, id, params, deps);
}
