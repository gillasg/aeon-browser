// page.state.stores(): a read of the app state the page already holds, with no network call, no
// debugger and nothing written to the page. Hydration blobs (__NEXT_DATA__, Remix, Nuxt) and live
// stores (Apollo cache, TanStack Query cache, Redux, Zustand, Pinia/Vuex) are found through window
// properties, framework roots and React providers, then copied bounded and cycle-safe. The st*
// functions are page code joined by storesScript into one expression; the sandbox scrubs secrets.

export interface StoresOptions {
  /** Only these kinds: next, remix, nuxt, apollo, tanstack, redux, zustand, pinia, vuex. */
  kind?: string | string[];
  /** A JSON pointer into each store's data, e.g. "/ROOT_QUERY" or "/queries/0/data". */
  path?: string;
  maxDepth?: number;
  maxKeys?: number;
  maxNodes?: number;
}

interface StCtx {
  maxDepth: number;
  maxKeys: number;
  maxNodes: number;
  nodes: number;
}

type Bag = Record<string, unknown>;

/** Page side: a bounded, cycle-safe JSON copy. Functions, DOM nodes and cycles are named. */
function stCopy(value: unknown, ctx: StCtx, seen: WeakSet<object>, depth: number): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (typeof value === "string") return value.length > 500 ? value.slice(0, 500) + "…" : value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[fn]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[cycle]";
  if (depth >= ctx.maxDepth || ctx.nodes >= ctx.maxNodes)
    return Array.isArray(value) ? `[array ${value.length}]` : "[object]";
  if (typeof Node !== "undefined" && value instanceof Node) return "[node]";
  seen.add(value);
  ctx.nodes++;
  const out = stCopyInner(value, ctx, seen, depth);
  seen.delete(value);
  return out;
}

function stCopyInner(value: object, ctx: StCtx, seen: WeakSet<object>, depth: number): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, ctx.maxKeys).map((item) => stCopy(item, ctx, seen, depth + 1));
    return value.length > ctx.maxKeys ? [...items, `[+${value.length - ctx.maxKeys} more]`] : items;
  }
  if (value instanceof Map)
    return stCopy(
      Object.fromEntries(
        [...value.entries()].slice(0, ctx.maxKeys).map(([k, v]) => [String(k), v]),
      ),
      ctx,
      seen,
      depth,
    );
  if (value instanceof Set) return stCopy([...value].slice(0, ctx.maxKeys), ctx, seen, depth);
  const out: Bag = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, ctx.maxKeys)) {
    try {
      out[key] = stCopy((value as Bag)[key], ctx, seen, depth + 1);
    } catch {
      out[key] = "[unreadable]";
    }
  }
  if (keys.length > ctx.maxKeys) out["…"] = `+${keys.length - ctx.maxKeys} keys`;
  return out;
}

/** Page side: one step of a JSON pointer, or undefined. */
function stAt(value: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return value;
  let node = value;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = node instanceof Map ? node.get(key) : (node as Bag)[key];
  }
  return node;
}

function stFn(value: unknown, name: string): boolean {
  return Boolean(value) && typeof (value as Bag)[name] === "function";
}

/** Page side: live stores that React providers hold (Redux, TanStack Query, Apollo). */
function stFromReact(doc: Document, found: Bag[]): void {
  const root =
    doc.getElementById("__next") ?? doc.getElementById("root") ?? doc.body?.firstElementChild;
  const key = root
    ? Object.keys(root).find(
        (name) => name.startsWith("__reactContainer$") || name.startsWith("__reactFiber$"),
      )
    : undefined;
  let fiber = key ? ((root as unknown as Bag)[key] as Bag | undefined) : undefined;
  if (fiber && (fiber as Bag).stateNode && !(fiber as Bag).child)
    fiber = ((fiber as Bag).stateNode as Bag).current as Bag;
  const stack: Bag[] = fiber ? [fiber] : [];
  let visited = 0;
  while (stack.length && visited++ < 4000) {
    const node = stack.pop() as Bag;
    const props = (node.memoizedProps ?? {}) as Bag;
    stFromProps(props, found);
    if (node.sibling) stack.push(node.sibling as Bag);
    if (node.child) stack.push(node.child as Bag);
  }
}

function stFromProps(props: Bag, found: Bag[]): void {
  const client = props.client as Bag | undefined;
  const store = props.store as Bag | undefined;
  if (stFn(client, "getQueryCache"))
    found.push({ kind: "tanstack", source: "QueryClientProvider", live: client });
  else if (client && stFn(client.cache, "extract"))
    found.push({ kind: "apollo", source: "ApolloProvider", live: client });
  if (stFn(store, "getState") && stFn(store, "dispatch"))
    found.push({ kind: "redux", source: "Provider", live: store });
}

/** Page side: window globals and embedded blobs. */
function stFromWindow(w: Bag, doc: Document, found: Bag[]): void {
  const blob = (kind: string, source: string, data: unknown) => {
    if (data !== undefined && data !== null) found.push({ kind, source, data });
  };
  blob("next", "__NEXT_DATA__", w.__NEXT_DATA__);
  blob(
    "remix",
    "__remixContext",
    (w.__remixContext as Bag | undefined)?.state ?? w.__reactRouterContext,
  );
  blob("nuxt", "__NUXT__", w.__NUXT__);
  const nuxtData = doc.getElementById?.("__NUXT_DATA__")?.textContent;
  if (nuxtData) {
    try {
      blob("nuxt", "#__NUXT_DATA__", JSON.parse(nuxtData));
    } catch {
      // not JSON
    }
  }
  blob("apollo", "__APOLLO_STATE__", w.__APOLLO_STATE__);
  const apollo = w.__APOLLO_CLIENT__ as Bag | undefined;
  if (apollo && stFn(apollo.cache, "extract"))
    found.push({ kind: "apollo", source: "__APOLLO_CLIENT__", live: apollo });
  for (const name of ["__REACT_QUERY_CLIENT__", "__TANSTACK_QUERY_CLIENT__", "queryClient"])
    if (stFn(w[name], "getQueryCache"))
      found.push({ kind: "tanstack", source: name, live: w[name] });
  for (const name of Object.keys(w).slice(0, 2000)) {
    let value: unknown;
    try {
      value = w[name];
    } catch {
      continue;
    }
    if (!stFn(value, "getState") || !stFn(value, "subscribe")) continue;
    found.push({
      kind: stFn(value, "dispatch") ? "redux" : "zustand",
      source: "window." + name,
      live: value,
    });
  }
}

/** Page side: Vue 3 (Pinia) and Vue 2 (Vuex, Pinia) roots. */
function stFromVue(doc: Document, found: Bag[]): void {
  const el = (doc.querySelector?.("[data-v-app]") ??
    doc.getElementById?.("app") ??
    doc.getElementById?.("__nuxt")) as unknown as Bag | null;
  const app = el?.__vue_app__ as Bag | undefined;
  const globals = ((app?.config as Bag | undefined)?.globalProperties ?? {}) as Bag;
  const vue2 = el?.__vue__ as Bag | undefined;
  const pinia = (globals.$pinia ?? vue2?.$pinia) as Bag | undefined;
  if (pinia?.state)
    found.push({ kind: "pinia", source: "$pinia", data: (pinia.state as Bag).value });
  const vuex = (globals.$store ?? vue2?.$store) as Bag | undefined;
  if (vuex && "state" in vuex) found.push({ kind: "vuex", source: "$store", data: vuex.state });
}

/** Page side: the plain data a live store holds right now. Reads only: no dispatch, no set. */
function stRead(item: Bag): unknown {
  if (!item.live) return item.data;
  const live = item.live as Bag;
  if (item.kind === "apollo")
    return ((live.cache as Bag).extract as () => unknown).call(live.cache);
  if (item.kind === "tanstack") {
    const cache = (live.getQueryCache as () => Bag).call(live);
    const all = ((cache.getAll as () => Bag[]).call(cache) ?? []).slice(0, 200);
    return {
      queries: all.map((query) => {
        const state = (query.state ?? {}) as Bag;
        return {
          queryKey: query.queryKey,
          status: state.status,
          dataUpdatedAt: state.dataUpdatedAt,
          data: state.data,
        };
      }),
    };
  }
  return (live.getState as () => unknown).call(live);
}

function stSummary(data: unknown): Bag {
  if (Array.isArray(data)) return { type: "array", length: data.length };
  if (data && typeof data === "object") {
    const keys = Object.keys(data);
    return { type: "object", keyCount: keys.length, keys: keys.slice(0, 30) };
  }
  return { type: typeof data };
}

/** Page side: every store found, each as {kind, source, summary, data}. */
function stCollect(w: Bag, doc: Document, options: StoresOptions): Bag {
  const kinds = options.kind ? new Set(([] as string[]).concat(options.kind)) : undefined;
  const found: Bag[] = [];
  stFromWindow(w, doc, found);
  stFromReact(doc, found);
  stFromVue(doc, found);
  const seenLive = new Set<unknown>();
  const stores: Bag[] = [];
  for (const item of found) {
    if (kinds && !kinds.has(String(item.kind))) continue;
    if (item.live && seenLive.has(item.live)) continue;
    seenLive.add(item.live);
    const ctx: StCtx = {
      maxDepth: options.maxDepth ?? 6,
      maxKeys: options.maxKeys ?? 50,
      maxNodes: options.maxNodes ?? 3000,
      nodes: 0,
    };
    let data: unknown;
    try {
      data = stAt(stRead(item), options.path ?? "");
    } catch (error) {
      stores.push({
        kind: item.kind,
        source: item.source,
        error: String((error as Error)?.message ?? error).slice(0, 200),
      });
      continue;
    }
    stores.push({
      kind: item.kind,
      source: item.source,
      ...(options.path ? { path: options.path } : {}),
      summary: stSummary(data),
      data: stCopy(data, ctx, new WeakSet(), 0),
      ...(ctx.nodes >= ctx.maxNodes ? { truncated: true } : {}),
    });
  }
  return { stores, kinds: [...new Set(stores.map((store) => store.kind))] };
}

export const storesFunctions = [
  stCopy,
  stCopyInner,
  stAt,
  stFn,
  stFromReact,
  stFromProps,
  stFromWindow,
  stFromVue,
  stRead,
  stSummary,
  stCollect,
];

/** The page expression for one read: helpers, then stCollect(window, document, options). */
export function storesScript(options: StoresOptions = {}): string {
  return `(() => {${storesFunctions.map(String).join("\n")}\nreturn stCollect(window, document, ${JSON.stringify(options)});})()`;
}

export { stCollect as storesCollectForTest };
