// page.why(target): where a value on the page came from, joined without a model. Link 1 is the
// element (its text and box), link 2 the JSON that carried the value (a recorded response body or
// the page's hydration state) as an RFC 6901 pointer plus the mapped operation behind the request,
// link 3 the component that owns the element, link 4 the source file. Links that cannot be
// resolved are named in `missing`; the call never fails on a partial answer. When page.recordTab
// is running on the tab, a provenance event is kept for events.json so a recording can align JSON
// rows to what was on screen. The pure matching lives in provenance.ts, embedded here by source.
import { provenanceFunctions } from "./provenance.js";

/** Page side: resolve the element, read its text, box, owning component and hydration state. */
function whyPageRead(input: {
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
}): Record<string, unknown> {
  const visible = (el: Element): string =>
    String((el as HTMLElement).innerText ?? el.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const byText = (text: string): Element | null => {
    const want = text.replace(/\s+/g, " ").trim().toLowerCase();
    let best: Element | null = null;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const own = visible(el).toLowerCase();
      if (!own || !own.includes(want)) continue;
      if (!best || visible(best).length >= own.length) best = el;
    }
    return best;
  };
  let el: Element | null = null;
  if (typeof input.x === "number" && typeof input.y === "number")
    el = document.elementFromPoint(input.x, input.y);
  if (!el && input.selector) {
    try {
      el = document.querySelector(input.selector);
    } catch {
      el = null;
    }
  }
  if (!el && (input.text || input.selector)) el = byText(String(input.text || input.selector));
  const out: Record<string, unknown> = { hydration: whyHydration() };
  if (!el) return out;
  const box = el.getBoundingClientRect();
  const field = el as unknown as { value?: unknown };
  out.element = {
    value: typeof field.value === "string" && field.value ? field.value : visible(el),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    bounds: { x: box.left, y: box.top, width: box.width, height: box.height },
  };
  out.component = whyOwner(el);
  return out;
}

/** Page side: the nearest React or Vue component that owns el, with its source when the build kept it. */
function whyOwner(el: Element): Record<string, unknown> | undefined {
  const bag = el as unknown as Record<string, unknown>;
  const shallow = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, 12)) {
      const item = (value as Record<string, unknown>)[key];
      if (key === "children" || key.startsWith("_")) continue;
      out[key] =
        item === null || ["string", "number", "boolean"].includes(typeof item)
          ? typeof item === "string"
            ? item.slice(0, 120)
            : item
          : typeof item === "function"
            ? "[fn]"
            : "[obj]";
    }
    return out;
  };
  const key = Object.keys(bag).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  type Fiber = {
    type?: unknown;
    return?: Fiber;
    memoizedProps?: unknown;
    _debugSource?: Record<string, unknown>;
  };
  for (let fiber = key ? (bag[key] as Fiber) : undefined; fiber; fiber = fiber.return) {
    const type = fiber.type as { displayName?: string; name?: string } | string | undefined;
    if (!type || typeof type === "string") continue;
    const debug = fiber._debugSource;
    return {
      name: type.displayName || type.name || "Anonymous",
      framework: "react",
      props: shallow(fiber.memoizedProps),
      ...(debug
        ? { file: debug.fileName, line: debug.lineNumber, column: debug.columnNumber }
        : {}),
    };
  }
  for (let at: Element | null = el; at; at = at.parentElement) {
    const vue = (at as unknown as Record<string, unknown>).__vueParentComponent as
      { type?: { name?: string; __name?: string; __file?: string }; props?: unknown } | undefined;
    if (!vue) continue;
    return {
      name: vue.type?.name || vue.type?.__name || "Anonymous",
      framework: "vue",
      props: shallow(vue.props),
      ...(vue.type?.__file ? { file: vue.type.__file } : {}),
    };
  }
  return undefined;
}

/** Page side: the hydration state a framework left on the page, JSON-safe and size bounded. */
function whyHydration(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keep = (name: string, value: unknown): void => {
    try {
      const text = JSON.stringify(value);
      if (text && text.length < 3000000) out[name] = JSON.parse(text);
    } catch {
      /* not JSON-safe: skipped */
    }
  };
  const next = document.getElementById("__NEXT_DATA__");
  if (next) {
    try {
      out.__NEXT_DATA__ = JSON.parse(next.textContent || "");
    } catch {
      /* not valid JSON */
    }
  }
  const w = window as unknown as Record<string, unknown>;
  for (const name of [
    "__APOLLO_STATE__",
    "__INITIAL_STATE__",
    "__PRELOADED_STATE__",
    "__REDUX_STATE__",
    "__remixContext",
    "__NUXT__",
    "__staticRouterHydrationData",
    "__INITIAL_DATA__",
  ])
    if (w[name] && typeof w[name] === "object") keep(name, w[name]);
  const apollo = w.__APOLLO_CLIENT__ as { cache?: { extract?: () => unknown } } | undefined;
  if (!out.__APOLLO_STATE__ && apollo?.cache?.extract)
    keep("__APOLLO_STATE__", apollo.cache.extract());
  for (const name of ["__REDUX_STORE__", "store"]) {
    const store = w[name] as { getState?: () => unknown } | undefined;
    if (!out.redux && store && typeof store.getState === "function")
      keep("redux", store.getState());
  }
  return out;
}

export const browserWhyApi = `
${provenanceFunctions.map(String).join("\n")}
// One self-contained page expression: the helpers travel with the reader.
var __whyPageSource = ${JSON.stringify(`(function(){var whyHydration=${String(whyHydration)};var whyOwner=${String(whyOwner)};return ${String(whyPageRead)};})()`)};
var __whyIdShape = /^(\\d+|e\\d+|f\\d+:e\\d+|[a-z]\\d+)$/i;
// A selector, text, an observed id, or {selector, text, x, y}: always a page-side request.
async function __whyInput(target, input) {
  if (input && typeof input === 'object') return {selector: input.selector, text: input.text, x: input.x, y: input.y};
  if (typeof input === 'number' || __whyIdShape.test(String(input))) {
    var spec = __element(target, input);
    if (spec && spec.kind === 'backend') {
      var model = await browser.page(target).cdp('DOM.getBoxModel', {backendNodeId: spec.backendNodeId}).catch(() => null);
      var quad = model && model.model && model.model.border;
      if (quad) return {x: (quad[0] + quad[4]) / 2, y: (quad[1] + quad[5]) / 2, text: spec.name};
    }
    return {text: spec && spec.name};
  }
  return {selector: String(input), text: String(input)};
}
// Recorded JSON bodies on this tab, oldest first, each searched for the value.
async function __whyNetwork(page, value, missing) {
  var entries;
  try { entries = await page.network.list(); } catch { missing.push('network-capture'); return []; }
  var json = (entries || []).filter((e) => /json|graphql/i.test(String(e.mimeType || e.type || '')) || /fetch|xhr/i.test(String(e.type || ''))).slice(-40);
  var found = [];
  for (var i = 0; i < json.length; i++) {
    var body;
    try { body = await page.network.body(json[i].id); } catch { continue; }
    var text = body && typeof body === 'object' ? body.body : body;
    var data; try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { continue; }
    for (var hit of provSearch(data, value)) found.push({...hit, recency: i + 1, source: 'network', entry: json[i]});
  }
  return found;
}
async function __whyOp(entry) {
  var host = ''; try { host = new URL(entry.url).hostname.replace(/^www\\./, ''); } catch { return undefined; }
  var ops = await siteMapper.operations(host).catch(() => null);
  return Array.isArray(ops) ? provOperation(entry.method, entry.url, ops) : undefined;
}
async function __whySource(page, component, key) {
  if (component && component.file) return {file: component.file, ...(component.line ? {line: component.line} : {}), ...(component.column ? {column: component.column} : {})};
  for (var search of [component && component.name !== 'Anonymous' ? component.name : '', key].filter(Boolean)) {
    var found = await page.sources({search, max: 1}).catch(() => null);
    var hit = found && found.hits && found.hits[0];
    if (hit) return {file: hit.file, line: hit.line};
  }
  return undefined;
}
async function __whyJoin(page, result, missing) {
  var best = result.best;
  if (!best) { missing.push('network-body'); return; }
  result.jsonPath = best.pointer;
  if (best.source === 'network') {
    var e = best.entry, path = e.url; try { path = new URL(e.url).pathname; } catch {}
    var op = await __whyOp(e);
    if (!op) missing.push('site-op');
    result.request = {id: e.id, method: String(e.method || 'GET').toUpperCase(), path, url: e.url, ...(e.status ? {status: e.status} : {}), ...(op ? {op} : {})};
  } else {
    missing.push('network-body');
    result.hydration = {kind: best.source};
  }
}
async function __pageWhy(target, input, options = {}) {
  var page = browser.page(target), missing = [];
  var read = (await page.inspect('(' + __whyPageSource + ')(' + JSON.stringify(await __whyInput(target, input)) + ')').catch(() => null)) || {};
  var el = read.element;
  if (!el) missing.push('element');
  var shown = String(options.value ?? (el ? el.value : (input && input.text) || (typeof input === 'string' ? input : '')));
  var result = {value: shown, ...(el && el.bounds ? {bounds: el.bounds} : {})};
  var value = provNormalize(shown), hydration = read.hydration || {};
  var candidates = await __whyNetwork(page, value, missing);
  for (var name of Object.keys(hydration).sort())
    for (var hit of provSearch(hydration[name], value)) candidates.push({...hit, recency: 0, source: name});
  result.best = provRank(candidates)[0];
  await __whyJoin(page, result, missing);
  delete result.best;
  if (read.component) result.component = {name: read.component.name, framework: read.component.framework, ...(read.component.props ? {props: read.component.props} : {})};
  else missing.push('component');
  var source = await __whySource(page, read.component, result.jsonPath && provLeafKey(result.jsonPath));
  if (source) result.source = source; else missing.push('source-map');
  if (missing.length) result.missing = [...new Set(missing)];
  var recording = typeof __provRecordings !== 'undefined' && __provRecordings.get(__key(target));
  if (recording) recording.push({type: 'provenance', t: Date.now(), jsonPath: result.jsonPath, value: shown, bounds: result.bounds,
    ...(result.request ? {request: {method: result.request.method, path: result.request.path, ...(result.request.op ? {op: result.request.op} : {})}} : {})});
  return result;
}
function __extendPageWhy(target, base) {
  return Object.assign(base, {why: (input, options = {}) => __pageWhy(target, input, options)});
}
`;
