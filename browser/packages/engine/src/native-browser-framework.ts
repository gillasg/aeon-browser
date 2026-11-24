// Framework and hydration inspector: which of React, Next.js, Vue, Svelte (or none) runs the page,
// a bounded component tree, and hydration-mismatch warnings. It runs only when page.framework.inspect()
// is called. The fw* functions are page code, joined by frameworkScript into one expression; scrubDeep
// runs in the sandbox on the result so no secret-shaped prop or state value ever leaves it.

export interface FrameworkOptions {
  maxDepth?: number;
  maxComponents?: number;
}

interface FwContext {
  maxDepth: number;
  maxComponents: number;
  all: Element[];
  w: Record<string, unknown>;
  components: Record<string, unknown>[];
  frameworks: Record<string, unknown>[];
}

type Fiber = {
  type?: unknown;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  child?: Fiber;
  sibling?: Fiber;
  return?: Fiber;
};

type VueInstance = {
  type?: { name?: string; __name?: string };
  props?: unknown;
  setupState?: unknown;
  subTree?: { component?: VueInstance; children?: unknown[] };
};

const SECRET_KEY =
  /pass(word|wd)?|secret|token|api[_-]?key|auth|session|cookie|credential|cvv|cvc|card|ssn|private/i;
const SECRET_VALUE =
  /\b(Bearer\s+\S{8,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|(?:\d[ -]?){13,19})\b/;

function scrubString(value: string): string {
  if (SECRET_VALUE.test(value)) return "[redacted]";
  return value.length > 300 ? value.slice(0, 300) + "…" : value;
}

/** A copy with secret-named keys and secret-shaped strings replaced by "[redacted]", depth and size capped. */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubDeep(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
    const leaf = item === null || typeof item !== "object";
    out[key] = SECRET_KEY.test(key) && leaf ? "[redacted]" : scrubDeep(item, depth + 1);
  }
  return out;
}

/** Page side: a JSON-safe shallow copy of props or state (functions and nodes named, not copied). */
function fwSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "function") return "[fn]";
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value !== "object") return value;
  if (depth > 2) return "[obj]";
  if (typeof Node !== "undefined" && value instanceof Node) return "[node]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => fwSafe(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 20)) {
    if (key === "children" || key.startsWith("_")) continue;
    try {
      out[key] = fwSafe((value as Record<string, unknown>)[key], depth + 1);
    } catch {
      out[key] = "[unreadable]";
    }
  }
  return out;
}

function fwReactKey(el: object): string | undefined {
  return Object.keys(el).find(
    (key) =>
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$") ||
      key.startsWith("__reactContainer$"),
  );
}

function fwReactWalk(ctx: FwContext, node: Fiber | undefined, depth: number): void {
  for (let at = node; at && ctx.components.length < ctx.maxComponents; at = at.sibling) {
    const type = at.type as { displayName?: string; name?: string } | string | undefined;
    const isComponent = !!type && typeof type !== "string";
    if (isComponent) {
      const hooks = at.memoizedState as { memoizedState?: unknown; next?: unknown } | undefined;
      const state =
        hooks && typeof hooks === "object" && "next" in hooks ? hooks.memoizedState : hooks;
      const named = type as { displayName?: string; name?: string };
      ctx.components.push({
        framework: "react",
        name: named.displayName || named.name || "Anonymous",
        depth,
        props: fwSafe(at.memoizedProps),
        state: fwSafe(state),
      });
    }
    if (depth < ctx.maxDepth) fwReactWalk(ctx, at.child, depth + (isComponent ? 1 : 0));
  }
}

function fwReact(ctx: FwContext): void {
  const host = ctx.all.find((el) => fwReactKey(el));
  if (!host) return;
  const hook = ctx.w.__REACT_DEVTOOLS_GLOBAL_HOOK__ as
    { renderers?: Map<number, { version?: string }> } | undefined;
  const version = hook?.renderers ? [...hook.renderers.values()][0]?.version : undefined;
  ctx.frameworks.push({ name: "react", version });
  let fiber = (host as unknown as Record<string, Fiber>)[fwReactKey(host) ?? ""];
  while (fiber && fiber.return) fiber = fiber.return;
  fwReactWalk(ctx, fiber, 0);
}

function fwNext(ctx: FwContext): void {
  const data = document.getElementById("__NEXT_DATA__");
  if (!data && !ctx.w.__next_f && !ctx.w.next) return;
  let parsed: { page?: string; buildId?: string } = {};
  try {
    parsed = data ? JSON.parse(data.textContent || "{}") : {};
  } catch {
    parsed = {};
  }
  ctx.frameworks.push({
    name: "next",
    router: data ? "pages" : "app",
    page: parsed.page,
    buildId: parsed.buildId,
  });
}

function fwVueVisit(ctx: FwContext, inst: VueInstance | undefined, depth: number): void {
  if (!inst || ctx.components.length >= ctx.maxComponents || depth > ctx.maxDepth) return;
  ctx.components.push({
    framework: "vue",
    name: inst.type?.name || inst.type?.__name || "Anonymous",
    depth,
    props: fwSafe(inst.props),
    state: fwSafe(inst.setupState),
  });
  fwVueVisit(ctx, inst.subTree?.component, depth + 1);
  for (const child of (inst.subTree?.children ?? []).slice(0, 50))
    fwVueVisit(ctx, (child as { component?: VueInstance }).component, depth + 1);
}

function fwVue(ctx: FwContext): void {
  const field = (el: Element, key: string): unknown =>
    (el as unknown as Record<string, unknown>)[key];
  const root = ctx.all.find((el) => field(el, "__vue_app__"));
  const any =
    root || ctx.all.find((el) => field(el, "__vueParentComponent") || field(el, "__vue__"));
  if (!any) return;
  const app = root
    ? (field(root, "__vue_app__") as { version?: string; _instance?: VueInstance })
    : undefined;
  ctx.frameworks.push({ name: "vue", version: app?.version });
  fwVueVisit(ctx, app?._instance, 0);
}

function fwSvelte(ctx: FwContext): void {
  const marked = (el: Element): boolean =>
    /\bsvelte-[a-z0-9]{4,}\b/.test(String(el.getAttribute("class") || "")) ||
    Object.keys(el).some((key) => key.startsWith("__svelte"));
  if (ctx.w.__svelte || ctx.all.some(marked)) ctx.frameworks.push({ name: "svelte" });
}

/** Page side: detect frameworks and collect a bounded component tree. */
function fwCollect(arg: FrameworkOptions): Record<string, unknown> {
  const ctx: FwContext = {
    maxDepth: Math.min(30, Math.max(1, Number(arg.maxDepth ?? 8))),
    maxComponents: Math.min(500, Math.max(1, Number(arg.maxComponents ?? 80))),
    all: [...document.querySelectorAll("*")].slice(0, 20000),
    w: window as unknown as Record<string, unknown>,
    components: [],
    frameworks: [],
  };
  fwReact(ctx);
  fwNext(ctx);
  fwVue(ctx);
  fwSvelte(ctx);
  const hydration: string[] = [];
  if (document.querySelector("nextjs-portal,#__next-build-watcher"))
    hydration.push("Next.js dev overlay is present: it shows hydration errors when there are any");
  return {
    frameworks: ctx.frameworks,
    components: ctx.components,
    hydration,
    truncated: ctx.components.length >= ctx.maxComponents,
  };
}

/** The page expression for page.inspect: every fw* helper plus a call with the options. */
export function frameworkScript(options: FrameworkOptions = {}): string {
  const helpers = [fwSafe, fwReactKey, fwReactWalk, fwReact, fwNext, fwVueVisit, fwVue, fwSvelte];
  const arg = JSON.stringify({ maxDepth: options.maxDepth, maxComponents: options.maxComponents });
  return (
    "(() => {" +
    helpers.map(String).join("\n") +
    "\nreturn (" +
    String(fwCollect) +
    ")(" +
    arg +
    ");})()"
  );
}

/** Console lines that name a hydration mismatch (React, Next.js and Vue wording). */
export function hydrationWarningsOf(lines: string[]): string[] {
  const pattern =
    /hydrat|did not match|server rendered html|text content does not match|server-rendered/i;
  return lines
    .filter((line) => pattern.test(line))
    .map((line) => line.slice(0, 300))
    .slice(0, 20);
}

/** The constants and page helpers frameworkScript and scrubDeep read, as sandbox source. */
export const frameworkSource = [
  "var SECRET_KEY = " + String(SECRET_KEY) + ";",
  "var SECRET_VALUE = " + String(SECRET_VALUE) + ";",
  ...[
    scrubString,
    fwSafe,
    fwReactKey,
    fwReactWalk,
    fwReact,
    fwNext,
    fwVueVisit,
    fwVue,
    fwSvelte,
    fwCollect,
  ].map(String),
].join("\n");
