// page.state.fiber(): a read-only scan of React fiber trees for the arrays a page renders from
// component props, hook state and (on request) class instances. Nothing is called or written: the
// fb* functions only read properties, each read guarded, with node, depth and match budgets so a
// huge tree stays fast. They are page code joined by fiberScript; the sandbox scrubs the result.

export interface FiberOptions {
  minLen?: number;
  keys?: string[];
  /** A name substring, or {source, flags} for a RegExp (the sandbox converts it). */
  component?: string | { source: string; flags: string };
  instance?: string | { source: string; flags: string };
  limit?: number;
  sampleSize?: number;
  maxNodes?: number;
}

interface FbCtx {
  minLen: number;
  keys: string[];
  limit: number;
  sampleSize: number;
  component: ((name: string) => boolean) | null;
  instance: ((name: string) => boolean) | null;
  seen: Set<unknown>;
  signatures: Set<string>;
  matches: any[];
}

/** Page side: one guarded property read. Getters that throw and cross-origin objects read as undefined. */
function fbGet(value: any, key: string): any {
  try {
    return value == null ? undefined : value[key];
  } catch {
    return undefined;
  }
}

function fbKeys(value: any): string[] {
  try {
    return value && typeof value === "object" ? Object.keys(value).slice(0, 200) : [];
  } catch {
    return [];
  }
}

function fbIsNode(value: any): boolean {
  try {
    return typeof Node !== "undefined" && value instanceof Node;
  } catch {
    return true;
  }
}

/** A small JSON-safe copy for samples: functions and nodes named, depth and width capped. */
function fbCopy(value: any, depth: number): any {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
  if (typeof value === "function") return "[fn]";
  if (typeof value !== "object") return String(value);
  if (fbIsNode(value)) return "[node]";
  if (depth >= 3) return Array.isArray(value) ? `[array ${value.length}]` : "[object]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => fbCopy(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of fbKeys(value).slice(0, 20)) {
    if (key.startsWith("_") || key === "children") continue;
    out[key] = fbCopy(fbGet(value, key), depth + 1);
  }
  return out;
}

function fbName(fiber: any): string {
  const type = fbGet(fiber, "type");
  if (typeof type === "string") return type;
  const inner = fbGet(type, "render") || fbGet(type, "type") || type;
  return String(
    fbGet(type, "displayName") ||
      fbGet(type, "name") ||
      fbGet(inner, "displayName") ||
      fbGet(inner, "name") ||
      "",
  );
}

function fbMatcher(spec: any): ((name: string) => boolean) | null {
  if (!spec) return null;
  if (typeof spec === "string") return (name) => name === spec || name.includes(spec);
  try {
    const re = new RegExp(spec.source, spec.flags);
    return (name) => re.test(name);
  } catch {
    return null;
  }
}

/** Offers one value: arrays of at least minLen (rows with every key) or, for instances, any object. */
function fbOffer(
  ctx: FbCtx,
  component: string,
  source: string,
  path: string,
  value: any,
  any_: boolean,
): void {
  if (ctx.matches.length >= ctx.limit * 5 || value == null || typeof value !== "object") return;
  if (fbIsNode(value) || ctx.seen.has(value)) return;
  const isArray = Array.isArray(value);
  if (!isArray && !any_) return;
  const len = isArray ? value.length : fbKeys(value).length;
  if (isArray && len < ctx.minLen) return;
  const first = isArray ? value.find((item: any) => item && typeof item === "object") : value;
  const keys = fbKeys(first).slice(0, 30);
  if (ctx.keys.length && !ctx.keys.every((key) => keys.includes(key))) return;
  ctx.seen.add(value);
  const sample = isArray
    ? value.slice(0, ctx.sampleSize).map((item: any) => fbCopy(item, 0))
    : fbCopy(value, 1);
  const signature = `${len}|${keys.join(",")}|${JSON.stringify(sample).slice(0, 400)}`;
  if (ctx.signatures.has(signature)) return;
  ctx.signatures.add(signature);
  ctx.matches.push({ component, source, path, len, keys, sample });
}

/** Looks at a value and, when it is a plain object, one and two levels inside it. */
function fbScan(
  ctx: FbCtx,
  component: string,
  source: string,
  path: string,
  value: any,
  depth: number,
): void {
  if (value == null || typeof value !== "object" || fbIsNode(value)) return;
  fbOffer(ctx, component, source, path, value, false);
  if (Array.isArray(value) || depth >= 2) return;
  for (const key of fbKeys(value).slice(0, 60)) {
    if (key === "children" || key.startsWith("_") || key.startsWith("$$")) continue;
    fbScan(ctx, component, source, `${path}.${key}`, fbGet(value, key), depth + 1);
  }
}

function fbHooks(ctx: FbCtx, component: string, state: any): void {
  let hook = state,
    index = 0;
  while (hook && typeof hook === "object" && index < 60) {
    if (!("next" in hook) || !("memoizedState" in hook)) {
      if (index === 0) fbScan(ctx, component, "hook", "state", hook, 0);
      return;
    }
    fbScan(ctx, component, "hook", `hooks[${index}]`, fbGet(hook, "memoizedState"), 0);
    hook = fbGet(hook, "next");
    index++;
  }
}

function fbInstance(ctx: FbCtx, component: string, node: any): void {
  if (!node || typeof node !== "object" || fbIsNode(node)) return;
  const skip = /^(props|context|refs|updater|state|_reactInternals|_reactInternalFiber)$/;
  for (const key of fbKeys(node)) {
    if (skip.test(key)) continue;
    const value = fbGet(node, key);
    if (value && typeof value === "object")
      fbOffer(ctx, component, "stateNode", `stateNode.${key}`, value, true);
  }
}

function fbVisit(ctx: FbCtx, fiber: any): void {
  const name = fbName(fiber);
  if (!name || typeof fbGet(fiber, "type") === "string") return;
  if (ctx.instance && ctx.instance(name)) fbInstance(ctx, name, fbGet(fiber, "stateNode"));
  if (ctx.component && !ctx.component(name)) return;
  const props = fbGet(fiber, "memoizedProps");
  for (const key of fbKeys(props)) {
    if (key === "children") continue;
    fbScan(ctx, name, "prop", `props.${key}`, fbGet(props, key), 0);
  }
  fbHooks(ctx, name, fbGet(fiber, "memoizedState"));
}

/** Fiber roots: the first fiber found on mounted elements, climbed to its root. */
function fbRoots(doc: any, budget: number): any[] {
  const roots = new Set<any>();
  let elements: any[] = [];
  try {
    elements = Array.from(doc.querySelectorAll("*")).slice(0, budget);
  } catch {
    return [];
  }
  for (const el of elements) {
    const key = fbKeys(el).find(
      (k) =>
        k.startsWith("__reactFiber$") ||
        k.startsWith("__reactInternalInstance$") ||
        k.startsWith("__reactContainer$"),
    );
    if (!key) continue;
    let fiber = fbGet(el, key);
    if (fbGet(fiber, "current")) fiber = fbGet(fiber, "current");
    for (let up = 0; fiber && fbGet(fiber, "return") && up < 5000; up++)
      fiber = fbGet(fiber, "return");
    if (fiber && !roots.has(fiber)) roots.add(fiber);
    if (roots.size >= 8) break;
  }
  return [...roots];
}

function fbRank(ctx: FbCtx): any[] {
  const score = (m: any) =>
    m.len * (m.keys.length ? 2 : 1) +
    (m.source === "stateNode" ? 1e6 : 0) +
    (m.keys.length ? 1e3 : 0);
  return ctx.matches.sort((a, b) => score(b) - score(a)).slice(0, ctx.limit);
}

/** Page side: walks every React root (bounded) and returns the ranked matches. */
function fbCollect(_win: any, doc: any, options: FiberOptions): any {
  const ctx: FbCtx = {
    minLen: Math.max(1, Number(options.minLen ?? 3)),
    keys: Array.isArray(options.keys) ? options.keys.map(String).slice(0, 12) : [],
    limit: Math.max(1, Math.min(200, Number(options.limit ?? 20))),
    sampleSize: Math.max(0, Math.min(10, Number(options.sampleSize ?? 3))),
    component: fbMatcher(options.component),
    instance: fbMatcher(options.instance),
    seen: new Set(),
    signatures: new Set(),
    matches: [],
  };
  const maxNodes = Math.max(100, Math.min(200000, Number(options.maxNodes ?? 30000)));
  const visited = new Set<any>();
  let scanned = 0;
  for (const root of fbRoots(doc, 20000)) {
    const stack: any[] = [root];
    while (stack.length && visited.size < maxNodes) {
      const fiber = stack.pop();
      if (!fiber || typeof fiber !== "object" || visited.has(fiber)) continue;
      visited.add(fiber);
      if (typeof fbGet(fiber, "type") !== "string" && fbName(fiber)) scanned++;
      fbVisit(ctx, fiber);
      const sibling = fbGet(fiber, "sibling");
      const child = fbGet(fiber, "child");
      if (sibling) stack.push(sibling);
      if (child) stack.push(child);
    }
  }
  const out: any = { componentsScanned: scanned, matches: fbRank(ctx) };
  if (visited.size >= maxNodes) out.truncated = true;
  return out;
}

export const fiberFunctions = [
  fbGet,
  fbKeys,
  fbIsNode,
  fbCopy,
  fbName,
  fbMatcher,
  fbOffer,
  fbScan,
  fbHooks,
  fbInstance,
  fbVisit,
  fbRoots,
  fbRank,
  fbCollect,
];

/** The page expression for one read: helpers, then fbCollect(window, document, options). */
export function fiberScript(options: FiberOptions = {}): string {
  return `(() => {${fiberFunctions.map(String).join("\n")}\nreturn fbCollect(window, document, ${JSON.stringify(options)});})()`;
}

export { fbCollect as fiberCollectForTest };
