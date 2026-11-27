// page.code.modules(): a read of the live webpack/Rspack module registry. A no-op chunk is pushed
// to each window.webpackChunk* array only to receive __webpack_require__, whose .m map holds every
// loaded module factory; each factory's source is read with Function.prototype.toString and
// grepped. No module is ever called and nothing is fetched. The probe entry is removed afterwards.
// The md* functions are page code joined by modulesScript; the sandbox scrubs the result.

export interface ModulesOptions {
  /** {source, flags} of the grep RegExp (the sandbox converts strings and RegExps). */
  grep?: { source: string; flags: string };
  limit?: number;
  maxModules?: number;
}

const DEFAULT_GREP = {
  source: "\\/api\\/|\\/v\\d+\\/|graphql|operationName|persistedQuery|sha256Hash|sign|nonce|csrf",
  flags: "i",
};

/** Page side: chunk array names on window, webpack and Rspack style. */
function mdChunkNames(win: any): string[] {
  let names: string[] = [];
  try {
    names = Object.getOwnPropertyNames(win);
  } catch {
    return [];
  }
  return names.filter((name) => /^(webpackChunk|rspackChunk)/.test(name)).slice(0, 20);
}

/** Pushes the probe chunk and returns __webpack_require__, or null. The entry is spliced back out. */
function mdRequire(arr: any): any {
  let req: any = null;
  const probe = ["__graft_probe_" + Math.random().toString(36).slice(2)];
  const entry = [
    probe,
    {},
    (r: any) => {
      req = r;
    },
  ];
  try {
    if (!Array.isArray(arr) || typeof arr.push !== "function") return null;
    arr.push(entry);
  } catch {
    return req;
  }
  try {
    const at = Array.prototype.indexOf.call(arr, entry);
    if (at >= 0) Array.prototype.splice.call(arr, at, 1);
  } catch {
    /* the array is frozen or proxied: the inert entry stays */
  }
  return req;
}

function mdPush(hits: any[], seen: Set<string>, kind: string, value: string): void {
  const key = kind + "|" + value;
  if (seen.has(key) || hits.length >= 20) return;
  seen.add(key);
  hits.push({ kind, value: value.slice(0, 200) });
}

/** Concise hits in one module's source: API paths, GraphQL names and hashes, signer names. */
function mdHits(src: string, grep: RegExp): any[] {
  const hits: any[] = [],
    seen = new Set<string>();
  const patterns: [string, RegExp, number][] = [
    [
      "url",
      /["'`]((?:https?:\/\/[^"'`\s]{1,120})?\/(?:api|graphql|v\d+)(?:\/[^"'`\s]{0,160})?)["'`]/g,
      1,
    ],
    ["operation", /operationName\s*[:=]\s*["'`]([A-Za-z_]\w{0,80})/g, 1],
    ["operation", /\b(?:query|mutation|subscription)\s+([A-Za-z_]\w{0,80})\s*[({]/g, 1],
    ["hash", /sha256Hash\s*["']?\s*[:=]\s*["'`]([a-f0-9]{64})/g, 1],
    [
      "signer",
      /\b((?:[A-Za-z_$][\w$]{0,40})?(?:[Ss]ign(?:ature)?|[Nn]once|[Cc]srf|[Hh]mac)[\w$]{0,30})\s*[(:=]/g,
      1,
    ],
  ];
  for (const [kind, re, group] of patterns) {
    for (const match of src.matchAll(re)) {
      mdPush(hits, seen, kind, String(match[group] ?? ""));
      if (hits.length >= 20) return hits;
    }
  }
  if (!hits.length) {
    const at = src.search(grep);
    if (at >= 0) mdPush(hits, seen, "grep", src.slice(Math.max(0, at - 60), at + 80));
  }
  return hits;
}

function mdScan(req: any, grep: RegExp, out: any, limit: number, maxModules: number): void {
  let factories: any;
  try {
    factories = req && req.m;
  } catch {
    return;
  }
  if (!factories || typeof factories !== "object") return;
  for (const id of Object.keys(factories)) {
    if (out.modulesScanned >= maxModules || out.matches.length >= limit) return;
    if (out.ids.has(id)) continue;
    out.ids.add(id);
    out.modulesScanned++;
    let src = "";
    try {
      src = Function.prototype.toString.call(factories[id]);
    } catch {
      continue;
    }
    const text = src.length > 500000 ? src.slice(0, 500000) : src;
    if (!grep.test(text)) continue;
    const hits = mdHits(text, grep);
    if (hits.length) out.matches.push({ id, bytes: src.length, hits });
  }
}

/** Page side: every chunk array's registry, scanned once per module id. */
function mdCollect(win: any, options: ModulesOptions): any {
  const spec = options.grep || DEFAULT_GREP;
  let grep: RegExp;
  try {
    grep = new RegExp(spec.source, spec.flags.replace(/g/g, ""));
  } catch {
    grep = new RegExp(DEFAULT_GREP.source, DEFAULT_GREP.flags);
  }
  const limit = Math.max(1, Math.min(500, Number(options.limit ?? 50)));
  const maxModules = Math.max(1, Math.min(100000, Number(options.maxModules ?? 50000)));
  const out: any = { modulesScanned: 0, matches: [], ids: new Set() };
  const chunks: string[] = [];
  for (const name of mdChunkNames(win)) {
    let arr: any;
    try {
      arr = win[name];
    } catch {
      continue;
    }
    const req = mdRequire(arr);
    if (!req) continue;
    chunks.push(name);
    mdScan(req, grep, out, limit, maxModules);
  }
  const result: any = { chunks, modulesScanned: out.modulesScanned, matches: out.matches };
  let legacy = false;
  try {
    legacy = Array.isArray(win.webpackJsonp);
  } catch {
    /* unreadable */
  }
  if (!chunks.length && legacy)
    result.notes = [
      "legacy webpackJsonp registry: the live probe does not apply; try page.code.bundle()",
    ];
  return result;
}

export const modulesFunctions = [mdChunkNames, mdRequire, mdPush, mdHits, mdScan, mdCollect];

/** The page expression for one scan: helpers, then mdCollect(window, options). */
export function modulesScript(options: ModulesOptions = {}): string {
  return `(() => {var DEFAULT_GREP = ${JSON.stringify(DEFAULT_GREP)};\n${modulesFunctions.map(String).join("\n")}\nreturn mdCollect(window, ${JSON.stringify(options)});})()`;
}

export { mdCollect as modulesCollectForTest };
