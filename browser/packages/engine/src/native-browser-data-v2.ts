// page.data() v2: the embedded data page.data() did not see. {attrs: true} parses data-* attributes
// that hold JSON (data-props, data-blob, data-a-state, data-mw...); {globals: true} copies inline
// window data globals (ytInitialData, _preloads, __DISCOGS_DATA__...) and other large plain ones;
// {find, deep: true} walks every source to depth 30 for arrays, objects and scalar fields by key.
// The dv* functions are page code joined by dataV2Script; everything is bounded and read-only.

export interface DataV2Options {
  attrs?: boolean;
  globals?: boolean;
  find?: string | string[];
  deep?: boolean;
  max?: number;
}

const KNOWN_GLOBALS = [
  "ytInitialData",
  "ytInitialPlayerResponse",
  "__DISCOGS_DATA__",
  "_preloads",
  "__BXD_DATA",
  "StoreDefaults",
  "CLIENT_ENV",
  "__staticRouterHydrationData",
  "__NUXT__",
  "__APOLLO_STATE__",
  "__INITIAL_STATE__",
  "__PRELOADED_STATE__",
  "__INITIAL_DATA__",
];

/** Page side: a bounded JSON copy; functions, nodes, windows and cycles are dropped or named. */
function dvCopy(value: any, depth: number, seen: Set<any>, budget: { n: number }): any {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  if (typeof value !== "object") return undefined;
  if (seen.has(value) || depth > 30 || budget.n <= 0) return undefined;
  try {
    if (typeof Node !== "undefined" && value instanceof Node) return undefined;
    if (value.window === value) return undefined;
  } catch {
    return undefined;
  }
  seen.add(value);
  budget.n--;
  let out: any;
  if (Array.isArray(value))
    out = value.slice(0, 500).map((item) => dvCopy(item, depth + 1, seen, budget));
  else {
    out = {};
    let keys: string[] = [];
    try {
      keys = Object.keys(value).slice(0, 300);
    } catch {
      keys = [];
    }
    for (const key of keys) {
      let item: any;
      try {
        item = value[key];
      } catch {
        continue;
      }
      const copied = dvCopy(item, depth + 1, seen, budget);
      if (copied !== undefined) out[key] = copied;
    }
  }
  seen.delete(value);
  return out;
}

function dvSize(value: any): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function dvTopKeys(value: any): string[] | number {
  return Array.isArray(value)
    ? value.length
    : value && typeof value === "object"
      ? Object.keys(value).slice(0, 20)
      : [];
}

function dvSelector(el: any): string {
  const tag = String(el.tagName || "").toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return cls ? `${tag}.${cls}` : tag;
}

/** data-* attributes whose value parses as a JSON object or array. */
function dvAttrs(doc: any): any[] {
  const out: any[] = [];
  let elements: any[] = [];
  try {
    elements = Array.from(doc.querySelectorAll("*")).slice(0, 30000);
  } catch {
    return out;
  }
  for (const el of elements) {
    const attributes = el.attributes ? Array.from(el.attributes as ArrayLike<any>) : [];
    for (const attr of attributes) {
      if (out.length >= 200) return out;
      const name = String(attr.name || ""),
        text = String(attr.value || "").trim();
      if (!name.startsWith("data-") || text.length < 2 || text.length > 2000000) continue;
      if (!/^[[{]/.test(text)) continue;
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      out.push({
        selector: dvSelector(el),
        attr: name,
        bytes: text.length,
        keys: dvTopKeys(value),
        value,
      });
    }
  }
  return out;
}

/** Known data globals, plus other large plain objects and arrays assigned on window. */
function dvGlobals(win: any): any[] {
  const out: any[] = [];
  let names: string[] = [];
  try {
    names = Object.getOwnPropertyNames(win);
  } catch {
    return out;
  }
  const known = new Set(KNOWN_GLOBALS);
  const ordered = [
    ...KNOWN_GLOBALS.filter((n) => names.includes(n)),
    ...names.filter((n) => !known.has(n)),
  ];
  for (const name of ordered.slice(0, 5000)) {
    if (
      out.length >= 30 ||
      /^\d+$/.test(name) ||
      name === "window" ||
      name === "self" ||
      name === "top"
    )
      continue;
    let value: any;
    try {
      value = win[name];
      if (!value || typeof value !== "object" || value.window === value) continue;
      if (typeof Node !== "undefined" && value instanceof Node) continue;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) continue;
    } catch {
      continue;
    }
    const copy = dvCopy(value, 0, new Set(), { n: 20000 });
    const bytes = dvSize(copy);
    if (!known.has(name) && bytes < 2000) continue;
    out.push({ name, bytes, keys: dvTopKeys(copy), value: copy });
  }
  return out;
}

/** The sources page.data() reads, parsed again here so the deep walk sees all of them. */
function dvDocSources(doc: any): any[] {
  const out: any[] = [];
  let tags: any[] = [];
  try {
    tags = Array.from(
      doc.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]'),
    );
  } catch {
    return out;
  }
  for (const tag of tags.slice(0, 200)) {
    const text = String(tag.textContent || "");
    if (text.length > 3000000) continue;
    try {
      const name =
        tag.id === "__NEXT_DATA__"
          ? "nextData"
          : tag.type.includes("ld")
            ? "jsonLd"
            : `jsonScripts${tag.id ? "#" + tag.id : ""}`;
      out.push({ source: name, value: JSON.parse(text) });
    } catch {
      /* not JSON */
    }
  }
  return out;
}

/** Depth-first walk to depth 30: keyed arrays of objects, objects with every key, scalar fields. */
function dvFind(source: string, root: any, find: string[], hits: any[], max: number): void {
  const stack: [any, string, number][] = [[root, "", 0]];
  const seen = new Set<any>();
  while (stack.length && hits.length < max) {
    const [value, path, depth] = stack.pop() as [any, string, number];
    if (!value || typeof value !== "object" || seen.has(value) || depth > 30) continue;
    seen.add(value);
    const entries: [string, any][] = Array.isArray(value)
      ? value.slice(0, 2000).map((item, i) => [String(i), item])
      : Object.entries(value);
    if (Array.isArray(value)) {
      const first = value.find((item) => item && typeof item === "object" && !Array.isArray(item));
      if (first && find.every((key) => key in first))
        hits.push({
          source,
          path: path || "/",
          kind: "array",
          len: value.length,
          value: value.slice(0, 50),
        });
    } else if (find.length > 1 && find.every((key) => key in value))
      hits.push({ source, path: path || "/", kind: "object", value });
    for (const [key, item] of entries) {
      const at = `${path}/${key}`;
      if (find.length === 1 && key === find[0] && !Array.isArray(value)) {
        const kind = Array.isArray(item)
          ? "array"
          : item && typeof item === "object"
            ? "object"
            : "scalar";
        hits.push({
          source,
          path: at,
          kind,
          ...(Array.isArray(item)
            ? { len: item.length, value: item.slice(0, 50) }
            : { value: item }),
        });
      }
      if (item && typeof item === "object") stack.push([item, at, depth + 1]);
    }
  }
}

/** Page side: the parts asked for. */
function dvCollect(win: any, doc: any, options: DataV2Options): any {
  const out: any = {};
  const deep = options.deep === true && options.find != null;
  const attrs = options.attrs || deep ? dvAttrs(doc) : [];
  const globals = options.globals || deep ? dvGlobals(win) : [];
  if (options.attrs) out.attrs = attrs;
  if (options.globals) out.globals = globals;
  if (deep) {
    const find = ([] as string[])
      .concat(options.find as string[])
      .map(String)
      .slice(0, 12);
    const hits: any[] = [];
    const max = Math.max(1, Math.min(200, Number(options.max) || 50));
    const sources = [
      ...dvDocSources(doc),
      ...attrs.map((a) => ({ source: `attr:${a.selector}[${a.attr}]`, value: a.value })),
      ...globals.map((g) => ({ source: `global:${g.name}`, value: g.value })),
    ];
    for (const item of sources) dvFind(item.source, item.value, find, hits, max);
    out.find = find;
    out.deep = true;
    out.matches = hits;
    out.sources = sources.map((s) => s.source).slice(0, 100);
  }
  return out;
}

export const dataV2Functions = [
  dvCopy,
  dvSize,
  dvTopKeys,
  dvSelector,
  dvAttrs,
  dvGlobals,
  dvDocSources,
  dvFind,
  dvCollect,
];

/** The page expression: helpers, then dvCollect(window, document, options). */
export function dataV2Script(options: DataV2Options = {}): string {
  return `(() => {var KNOWN_GLOBALS = ${JSON.stringify(KNOWN_GLOBALS)};\n${dataV2Functions.map(String).join("\n")}\nreturn dvCollect(window, document, ${JSON.stringify(options)});})()`;
}

export { dvCollect as dataV2CollectForTest };
