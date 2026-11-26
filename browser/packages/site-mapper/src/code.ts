import { analyzeBundles, confirmCandidates, type BundleGraph } from "./bundle-graph.js";
import { siteStartUrl } from "./registry.js";
import { sharedBridge } from "./runtime/bridge.js";
import { discoverMapUrl, mapUrlRefusal } from "./sourcemap.js";

// How a site works: one read of its HTML, JS chunks, route manifests, source maps, robots and
// sitemap. Plain HTTP first; a refused or gated request is retried through the user's browser.

export interface SiteCodeOptions {
  /** One string or regex, or a list; matches are returned with file, line and context. */
  grep?: string | readonly string[];
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** Parse the JS for candidate API calls, routes and chunks (default true). */
  bundle?: boolean;
  /** Requests already seen, so candidates they hit are marked confirmed. */
  observed?: readonly { method?: string; url: string; body?: string }[];
  /** Script bodies the browser already holds, by URL: used before fetching them again. */
  cached?: Readonly<Record<string, string>>;
}

export interface SiteCodeMatch {
  file: string;
  line: number;
  text: string;
}

export interface SiteCodeRoute {
  route: string;
  chunks: string[];
  source: string;
}

export interface SiteCodeResult {
  url: string;
  finalUrl: string;
  summary: string;
  routes: SiteCodeRoute[];
  files: { url: string; status: number; bytes: number; via: "http" | "chrome" }[];
  sourceMaps: { url: string; sources: string[] }[];
  robots: string[];
  sitemap: string[];
  matches: SiteCodeMatch[];
  /** Static candidates from the bundles: hypotheses until traffic confirms them. */
  bundle?: BundleGraph;
  notes: string[];
  truncated: boolean;
}

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 12_000_000;
const MAX_MATCHES = 120;
const DEFAULT_TIMEOUT = 15_000;

export async function code(input: string, options: SiteCodeOptions = {}): Promise<SiteCodeResult> {
  // A bare site starts where it was used (its mapped origin or its abilities' port), not https.
  const url = pageUrl(/^https?:\/\//i.test(input.trim()) ? input : await siteStartUrl(input));
  const origin = new URL(url).origin;
  const { maxFiles, maxBytes, timeoutMs } = limits(options);
  const page = await read(url, maxBytes, timeoutMs);
  const scripts = refused(page) ? [] : scriptsOf(page.text, page.url);
  const buildId = buildIdOf(page.text);
  const collected = await collectFiles(
    scripts,
    manifestCandidates(page.url, buildId, scripts),
    origin,
    maxFiles,
    maxBytes,
    timeoutMs,
    options.cached,
  );
  // A 4xx/5xx or bot challenge page is not the site: its markup must not read as the site's code.
  const texts = pageTexts(page, collected);
  const sourceMaps = await collectSourceMaps(
    texts,
    collected,
    { origin, page: page.url },
    maxBytes,
    timeoutMs,
  );
  const bundle = options.bundle === false ? undefined : bundleOf(texts, options.observed);
  const discovery = await collectDiscovery(page.url, maxBytes, timeoutMs);
  const matches = options.grep ? grepFiles(texts, options.grep) : [];
  const routes = uniqueRoutes([...collected.routes, ...sourceMaps.routes]);
  return {
    url,
    finalUrl: page.url,
    summary: [
      `${routes.length} routes, ${collected.files.length} files, ${sourceMaps.maps.length} source maps, ${matches.length} matches`,
      ...(bundle ? [bundle.summary] : []),
    ].join("; "),
    routes,
    files: collected.files,
    sourceMaps: sourceMaps.maps,
    robots: discovery.robots.slice(0, 100),
    sitemap: discovery.sitemap.slice(0, 500),
    matches: matches.slice(0, MAX_MATCHES),
    ...(bundle ? { bundle } : {}),
    notes: [
      ...(page.via === "chrome" ? ["page read through the browser"] : []),
      ...collected.notes,
      ...sourceMaps.notes,
    ],
    truncated:
      collected.files.some((file) => file.bytes >= maxBytes) || matches.length > MAX_MATCHES,
  };
}

function limits(options: SiteCodeOptions): {
  maxFiles: number;
  maxBytes: number;
  timeoutMs: number;
} {
  return {
    maxFiles: Math.max(1, Math.min(200, options.maxFiles ?? DEFAULT_MAX_FILES)),
    maxBytes: Math.max(10_000, Math.min(8_000_000, options.maxBytes ?? DEFAULT_MAX_BYTES)),
    timeoutMs: Math.max(1_000, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT)),
  };
}

async function collectFiles(
  scripts: string[],
  manifests: string[],
  origin: string,
  maxFiles: number,
  maxBytes: number,
  timeoutMs: number,
  cached: Readonly<Record<string, string>> = {},
): Promise<{
  files: SiteCodeResult["files"];
  texts: [string, string][];
  headers: Map<string, Record<string, string>>;
  routes: SiteCodeRoute[];
  notes: string[];
}> {
  const headers = new Map<string, Record<string, string>>();
  const files: SiteCodeResult["files"] = [];
  const texts: [string, string][] = [];
  const routes: SiteCodeRoute[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const [urls, source] of [
    [scripts, "script"],
    [manifests, "manifest"],
  ] as const) {
    for (const url of urls) {
      if (!sameOrigin(url, origin) || seen.has(url) || files.length >= maxFiles) continue;
      seen.add(url);
      const file = await heldOrFetched(url, cached, maxBytes, timeoutMs);
      if (!file || refused(file)) continue;
      files.push(meta(file));
      texts.push([file.url, file.text]);
      headers.set(file.url, file.headers);
      total += file.text.length;
      if (source === "manifest" || isManifestName(file.url))
        routes.push(...routesFrom(file.url, file.text, file.url));
      if (total >= MAX_TOTAL_BYTES) {
        notes.push("stopped after the total size cap");
        return { files, texts, headers, routes, notes };
      }
    }
  }
  return { files, texts, headers, routes, notes };
}

function bundleOf(texts: Map<string, string>, observed: SiteCodeOptions["observed"]): BundleGraph {
  const scripts = [...texts].filter(
    ([url]) => /\.m?js(?:\?|$)/i.test(url) || !/\.\w+(?:\?|$)/.test(url),
  );
  const inline = [...texts].flatMap(([url, text]) =>
    [...text.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([^]*?)<\/script>/gi)].map(
      (match, index) => [`${url}#inline-${index + 1}`, match[1] ?? ""] as const,
    ),
  );
  const graph = analyzeBundles([...inline, ...scripts.filter(([, text]) => !/^\s*</.test(text))]);
  return observed?.length ? confirmCandidates(graph, observed) : graph;
}

async function collectSourceMaps(
  texts: Map<string, string>,
  collected: { files: SiteCodeResult["files"]; headers: Map<string, Record<string, string>> },
  where: { origin: string; page: string },
  maxBytes: number,
  timeoutMs: number,
): Promise<{ maps: SiteCodeResult["sourceMaps"]; routes: SiteCodeRoute[]; notes: string[] }> {
  const maps: SiteCodeResult["sourceMaps"] = [];
  const routes: SiteCodeRoute[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const { files } = collected;
  for (const [fileUrl, text] of texts) {
    const target = mapTarget(fileUrl, text, collected.headers.get(fileUrl), where) ?? {};
    if (target.refused) notes.push(target.refused);
    const mapUrl = target.url;
    if (!mapUrl || seen.has(mapUrl)) continue;
    seen.add(mapUrl);
    const map = await optional(mapUrl, maxBytes, timeoutMs);
    if (!map) continue;
    files.push(meta(map));
    const sources = mapSources(map.text);
    if (!sources) {
      notes.push(`source map was not JSON: ${map.url}`);
      continue;
    }
    if (sources.length) maps.push({ url: map.url, sources });
    routes.push(...sourceRoutes(sources, map.url));
  }
  return { maps, routes, notes };
}

/** The map to read for a script, or why it is refused; undefined for non-scripts. */
function mapTarget(
  fileUrl: string,
  text: string,
  headers: Record<string, string> | undefined,
  where: { origin: string; page: string },
): { url?: string; refused?: string } | undefined {
  if (!/\.m?js(?:\?|$)/i.test(fileUrl)) return undefined;
  const url = discoverMapUrl(fileUrl, text, headers) ?? `${fileUrl}.map`;
  const refused = mapUrlRefusal(url, where.page);
  if (refused) return { refused: `${refused}: ${url}` };
  return sameOrigin(url, where.origin) ? { url } : undefined;
}

function sourceRoutes(sources: string[], mapUrl: string): SiteCodeRoute[] {
  return sources.flatMap((source) =>
    routeStrings(source).map((route) => ({ route, chunks: [mapUrl], source: "source-map" })),
  );
}

function mapSources(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as { sources?: unknown };
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    return sources.filter((item): item is string => typeof item === "string").slice(0, 500);
  } catch {
    return undefined;
  }
}

async function collectDiscovery(
  pageUrl: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ robots: string[]; sitemap: string[] }> {
  const robotsFile = await optional(new URL("/robots.txt", pageUrl).href, maxBytes, timeoutMs);
  const robots = robotsFile
    ? robotsFile.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const sitemaps = robots
    .map((line) => /^sitemap:\s*(\S+)/i.exec(line)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => absolute(value, pageUrl))
    .filter((value): value is string => Boolean(value));
  const sitemap: string[] = [];
  for (const sitemapUrl of [...new Set(sitemaps)].slice(0, 4)) {
    const file = await optional(sitemapUrl, maxBytes, timeoutMs);
    if (!file) continue;
    sitemap.push(...urlsFromSitemap(file.text));
    if (sitemap.length >= 500) break;
  }
  return { robots, sitemap: [...new Set(sitemap)] };
}

function absolute(value: string, base: string): string | undefined {
  try {
    return new URL(value, base).href;
  } catch {
    return undefined;
  }
}

export async function read(url: string, maxBytes: number, timeoutMs: number): Promise<CodeFile> {
  let plain: string | undefined;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html,application/javascript,application/json,*/*" },
    });
    plain = (await response.text()).slice(0, maxBytes);
    if (response.ok || response.status === 404) {
      return {
        url: response.url || url,
        status: response.status,
        text: plain,
        headers: Object.fromEntries(response.headers),
        via: "http",
      };
    }
  } catch {
    // fall through to the browser
  }
  try {
    const bridge = await sharedBridge();
    const value = (await bridge.run(
      `browser.fetch(${JSON.stringify(url)}, { as: "text", timeoutMs: ${timeoutMs} })`,
      { session: "site-code", timeoutMs: timeoutMs + 5_000 },
    )) as { status?: number; url?: string; text?: string; headers?: Record<string, string> };
    return {
      url: value.url || url,
      status: Number(value.status ?? 0),
      text: String(value.text ?? "").slice(0, maxBytes),
      headers: value.headers ?? {},
      via: "chrome",
    };
  } catch (error) {
    if (!plain) throw error;
    return { url, status: 0, text: plain, headers: {}, via: "http" };
  }
}

function buildIdOf(text: string): string | undefined {
  return (
    /\/_next\/static\/([^/"']+)\/_buildManifest\.js/.exec(text)?.[1] ??
    /"buildId"\s*:\s*"([^"]+)"/.exec(text)?.[1]
  );
}

// A 4xx/5xx or bot challenge page is not the site: its markup must not read as the site's code.
function pageTexts(
  page: CodeFile,
  collected: { texts: [string, string][]; notes: string[] },
): Map<string, string> {
  if (!refused(page)) return new Map([[page.url, page.text], ...collected.texts]);
  collected.notes.push(`the page answered ${page.status || "a challenge"}, not the site`);
  return new Map(collected.texts);
}

/** An error status or a bot challenge (Cloudflare, Vercel) in place of the real file. */
export function refused(file: Pick<CodeFile, "status" | "text">): boolean {
  if (file.status >= 400) return true;
  const head = file.text.slice(0, 20_000);
  return (
    /^\s*</.test(head) &&
    /__cf_chl_(rt_tk|opt|jschl)|cdn-cgi\/challenge-platform|<title>\s*Just a moment|vercel\/security|_vercel\/security|x-vercel-challenge/i.test(
      head,
    )
  );
}

export interface CodeFile {
  url: string;
  status: number;
  text: string;
  headers: Record<string, string>;
  via: "http" | "chrome";
}

/** A script the browser already holds, else one file over plain HTTP. */
async function heldOrFetched(
  url: string,
  cached: Readonly<Record<string, string>>,
  maxBytes: number,
  timeoutMs: number,
): Promise<CodeFile | undefined> {
  const held = Object.hasOwn(cached, url) ? cached[url] : undefined;
  if (held === undefined) return optional(url, maxBytes, timeoutMs);
  return { url, status: 200, text: held.slice(0, maxBytes), headers: {}, via: "chrome" };
}

/** One file over plain HTTP, or through the browser when refused; undefined when unreadable. */
export async function optional(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<CodeFile | undefined> {
  try {
    if (!/^https?:/i.test(url)) return undefined;
    return await read(url, maxBytes, timeoutMs);
  } catch {
    return undefined;
  }
}

function meta(file: { url: string; status: number; text: string; via: "http" | "chrome" }) {
  return { url: file.url, status: file.status, bytes: file.text.length, via: file.via };
}

function pageUrl(input: string): string {
  const value = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("code needs an http(s) URL");
  return url.href;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function scriptsOf(html: string, page: string): string[] {
  const found = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(
    (match) => match[1],
  );
  return found
    .map((src) => {
      try {
        return new URL(src ?? "", page).href;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));
}

function manifestCandidates(
  page: string,
  buildId: string | undefined,
  scripts: string[],
): string[] {
  const origin = new URL(page).origin;
  const list = [
    "/build-manifest.json",
    "/asset-manifest.json",
    "/manifest.json",
    "/app-build-manifest.json",
    "/remix-manifest.json",
    "/.vite/manifest.json",
    ...(buildId
      ? [
          `/_next/static/${buildId}/_buildManifest.js`,
          `/_next/static/${buildId}/_ssgManifest.js`,
          `/_next/static/${buildId}/app-build-manifest.json`,
        ]
      : []),
  ].map((path) => new URL(path, origin).href);
  return [...list, ...scripts.filter(isManifestName)];
}

function isManifestName(url: string): boolean {
  return /(?:build|asset|routes|remix|vite)[^/]*manifest|manifest\.json/i.test(url);
}

function routesFrom(url: string, text: string, source: string): SiteCodeRoute[] {
  const routes: SiteCodeRoute[] = [];
  const pairs = [...text.matchAll(/["'](\/[^"']+)["']\s*:\s*\[([^\]]*)\]/g)];
  for (const pair of pairs) {
    const route = pair[1];
    if (!route || route.startsWith("//")) continue;
    const chunks = [...(pair[2] ?? "").matchAll(/["']([^"']+)["']/g)]
      .map((match) => {
        try {
          return new URL(match[1] ?? "", url).href;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is string => Boolean(value));
    routes.push({ route, chunks, source });
  }
  if (routes.length) return routes;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const [route, value] of Object.entries(parsed)) {
      if (!route.startsWith("/")) continue;
      routes.push({
        route,
        chunks: chunksFor(value).map((chunk) => new URL(chunk, url).href),
        source,
      });
    }
  } catch {
    // a JS manifest; the pair scan above is the useful part
  }
  return routes;
}

function chunksFor(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (value && typeof value === "object" && typeof (value as { file?: unknown }).file === "string")
    return [(value as { file: string }).file];
  return [];
}

function routeStrings(value: string): string[] {
  return [...value.matchAll(/\/(?:app|pages|routes|src)\/[^"'\s)]+/g)].map((match) => match[0]);
}

function urlsFromSitemap(text: string): string[] {
  return [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

function grepFiles(
  texts: Map<string, string>,
  patterns: string | readonly string[],
): SiteCodeMatch[] {
  const values = typeof patterns === "string" ? [patterns] : [...patterns];
  const matchers = values.map((value) => {
    try {
      return new RegExp(value, "i");
    } catch {
      return value;
    }
  });
  const matches: SiteCodeMatch[] = [];
  for (const [file, text] of texts) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (
        !matchers.some((matcher) =>
          typeof matcher === "string" ? line.includes(matcher) : matcher.test(line),
        )
      )
        continue;
      matches.push({ file, line: index + 1, text: line.trim().slice(0, 120) });
      if (matches.length >= MAX_MATCHES) return matches;
    }
  }
  return matches;
}

function uniqueRoutes(routes: SiteCodeRoute[]): SiteCodeRoute[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    if (seen.has(route.route)) return false;
    seen.add(route.route);
    return true;
  });
}
