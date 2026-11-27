// What a running script leaves behind, so stopping it (disabled, removed, or its rules no longer
// match after an in-page navigation) takes it all back: nodes it added, listeners, timers,
// sockets, and its own GM.onStop handlers.
//
// In the isolated world each boost has a world of its own, so the DOM insertion methods, event
// listeners and timers of that world are wrapped to record what the script did. The page world
// is shared with the page, so there only GM_addElement, GM_addStyle and SB panels are recorded.

type Cleanup = () => void;

export interface Owner {
  /** Something to undo when the script stops. */
  add(cleanup: Cleanup): void;
  /** A node the script put in the page. */
  node(node: Node): void;
  /** A timer the script started; `done` when a timeout fired on its own. */
  timer(id: number, interval: boolean): void;
  timerDone(id: number): void;
}

interface WorldState {
  active?: Owner | undefined;
  original: {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    clearTimeout: typeof clearTimeout;
    clearInterval: typeof clearInterval;
    addEventListener: EventTarget["addEventListener"];
  };
}

const KEY = "__sbWorld";

/** The world's own timers and listeners, never recorded: the runtime itself uses these. */
export function world(): WorldState {
  const global = globalThis as unknown as Record<string, WorldState | undefined>;
  global[KEY] ??= {
    original: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      addEventListener: EventTarget.prototype.addEventListener,
    },
  };
  return global[KEY];
}

type Method = (this: Node, ...args: unknown[]) => unknown;

/** Nodes an insertion call adds that were not in the page before: the script made them. */
function fresh(args: unknown[]): Node[] {
  return args.filter(
    (arg): arg is Node =>
      typeof arg === "object" &&
      arg !== null &&
      "isConnected" in arg &&
      !(arg as Node).isConnected &&
      (arg as Node).nodeType !== 11,
  );
}

function wrapInsert(proto: object, name: string, pick: (args: unknown[]) => unknown[]): void {
  const original = (proto as Record<string, Method | undefined>)[name];
  if (typeof original !== "function") return;
  Object.defineProperty(proto, name, {
    configurable: true,
    writable: true,
    value: function (this: Node, ...args: unknown[]) {
      const owner = world().active;
      const added = owner ? fresh(pick(args)) : [];
      const result = original.apply(this, args);
      for (const node of added) owner?.node(node);
      return result;
    },
  });
}

function wrapTimers(state: WorldState): void {
  const { original } = state;
  globalThis.setTimeout = function (handler: unknown, ms?: number, ...rest: unknown[]) {
    const owner = state.active;
    if (!owner || typeof handler !== "function")
      return original.setTimeout(handler as () => void, ms, ...rest);
    const id = original.setTimeout(() => {
      owner.timerDone(id as unknown as number);
      (handler as (...a: unknown[]) => void)(...rest);
    }, ms) as unknown as number;
    owner.timer(id, false);
    return id;
  } as typeof setTimeout;
  globalThis.setInterval = function (handler: unknown, ms?: number, ...rest: unknown[]) {
    const id = original.setInterval(handler as () => void, ms, ...rest) as unknown as number;
    state.active?.timer(id, true);
    return id;
  } as typeof setInterval;
}

function wrapListeners(state: WorldState): void {
  const add = state.original.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    // A bare addEventListener(...) in strict code has no `this`: it means the window.
    const target = this ?? globalThis;
    add.call(target, type, listener, options);
    if (listener)
      state.active?.add(() => target.removeEventListener(type, listener, options as boolean));
  };
}

let wrapped = false;

/** Wraps this (isolated) world once, however many copies of the runtime run in it. */
export function trackWorld(): void {
  const state = world();
  if (wrapped || (state as { wrapped?: boolean }).wrapped) return;
  wrapped = true;
  (state as { wrapped?: boolean }).wrapped = true;
  const all = (args: unknown[]) => args;
  const first = (args: unknown[]) => args.slice(0, 1);
  for (const name of ["append", "prepend", "before", "after", "replaceWith"])
    wrapInsert(Element.prototype, name, all);
  for (const name of ["append", "prepend"]) wrapInsert(Document.prototype, name, all);
  for (const name of ["appendChild", "insertBefore", "replaceChild"])
    wrapInsert(Node.prototype, name, first);
  wrapInsert(Element.prototype, "insertAdjacentElement", (args) => args.slice(1, 2));
  wrapTimers(state);
  wrapListeners(state);
}

/** One run of a script: everything it set up, undone by `stop`. */
export class Run implements Owner {
  private readonly handlers: Cleanup[] = [];
  private readonly cleanups: Cleanup[] = [];
  private readonly nodes = new Set<Node>();
  private readonly timeouts = new Set<number>();
  private readonly intervals = new Set<number>();
  stopped = false;

  constructor(private readonly report: (error: unknown) => void) {}

  /** GM.onStop(fn): the script's own clean-up. */
  onStop(handler: Cleanup): void {
    if (typeof handler === "function" && !this.stopped) this.handlers.push(handler);
  }

  add(cleanup: Cleanup): void {
    if (this.stopped) return cleanup();
    this.cleanups.push(cleanup);
  }

  node(node: Node): void {
    if (!this.stopped) this.nodes.add(node);
  }

  timer(id: number, interval: boolean): void {
    if (!this.stopped) (interval ? this.intervals : this.timeouts).add(id);
  }

  timerDone(id: number): void {
    this.timeouts.delete(id);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // The script's own handlers first, while its nodes are still there to read.
    for (const run of [...this.handlers.splice(0), ...this.cleanups.splice(0).reverse()])
      try {
        run();
      } catch (error) {
        this.report(error);
      }
    const { original } = world();
    for (const id of this.timeouts) original.clearTimeout(id);
    for (const id of this.intervals) original.clearInterval(id);
    this.timeouts.clear();
    this.intervals.clear();
    for (const node of this.nodes) (node as ChildNode).remove?.();
    this.nodes.clear();
  }
}
