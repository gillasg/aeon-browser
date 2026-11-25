import { randomBytes } from "node:crypto";

// The default `aeon mcp` surface: five fixed tools, whatever the number of mapped sites.
//   browser_code  run JS in the persistent browser realm (done | paused | error)
//   aeon_find     search refs, or read one ref's .d.ts signature
//   aeon_call     run a mapped operation or ability by ref, no JS
//   aeon_resume   continue a parked cell or an aeon_run chat
//   aeon_run      hand a whole task to Aeon's own agent
// A cell that blocks on human.handoff / bu.handoff (a passkey, a fingerprint, a code) is parked:
// it stays an unresolved await in the daemon realm, and the caller gets a handle to resume.

type Json = Record<string, unknown>;

export const CODE_SURFACE_TOOLS = [
  {
    name: "browser_code",
    description:
      "Run JavaScript in the user's real Chrome, in a persistent realm: browser.*, page.*, site.*, human.*, mcp.* and help(topic). Variables survive between calls. Returns done, error, or paused when the user must act in Chrome (then aeon_resume).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1 },
        session: { type: "string", description: "REPL to use; default per client." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_find",
    description:
      "{query}: up to 8 refs (mapped site operations, abilities, compiled clients). {ref}: its .d.ts, effect and an example; site:<site> gives the whole typed client.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200 },
        ref: { type: "string", maxLength: 300 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "aeon_call",
    description:
      "Run a mapped operation or ability by ref with params, with the user's logins and no model.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", minLength: 1 }, params: { type: "object" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_resume",
    description:
      "Continue a paused browser_code cell or an aeon_run chat by handle. reply answers a run's question. Waits up to waitSeconds (max 50).",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", minLength: 1 },
        reply: { type: "string", maxLength: 20000 },
        waitSeconds: { type: "number", minimum: 0, maximum: 50 },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_run",
    description:
      "Hand a whole task to Aeon's own agent, as a chat in a background Chrome tab. Returns a handle for aeon_resume.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1, maxLength: 50000 },
        model: { type: "string", description: "provider/id" },
        quiet: { type: "boolean", description: "Do not open the chat tab." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
] as const;

export const CODE_SURFACE_NAMES: ReadonlySet<string> = new Set(
  CODE_SURFACE_TOOLS.map((tool) => tool.name),
);

/** What a pending hand-off says, as the tab lists it. */
export interface Handoff {
  why: string;
  kind?: string;
  tab?: string;
  title?: string;
}

export interface Paused {
  status: "paused";
  handle: string;
  why: string;
  kind: string;
  where: { tab: string; title: string };
  expiresAt: string;
  resumeWith: "aeon_resume";
}

const PARK_MS = 10 * 60_000;
const PARK_MAX_MS = 60 * 60_000;

/** The human sentence every client renders as the paused result's first line. */
export function pausedLine(why: string): string {
  return `paused · waiting for you in Chrome: ${why || "a step only you can do"}`;
}

export function pausedResult(paused: Paused): Json {
  return {
    content: [
      { type: "text", text: `${pausedLine(paused.why)}\n${JSON.stringify(paused, null, 2)}` },
    ],
    structuredContent: paused,
    isError: false,
  };
}

interface Parked {
  outcome: Promise<unknown>;
  settled?: { value: unknown };
  paused: Paused;
  createdAt: number;
}

/** Parked cells by handle. A parked cell is just a promise the daemon realm has not resolved. */
export class ParkingLot {
  private readonly cells = new Map<string, Parked>();

  park(outcome: Promise<unknown>, handoff: Handoff, now = Date.now()): Paused {
    this.sweep(now);
    const handle = `h_${randomBytes(16).toString("hex")}`;
    const paused: Paused = {
      status: "paused",
      handle,
      why: handoff.why,
      kind: handoff.kind ?? "auth",
      where: { tab: handoff.tab ?? "", title: handoff.title ?? "" },
      expiresAt: new Date(now + PARK_MS).toISOString(),
      resumeWith: "aeon_resume",
    };
    const parked: Parked = { outcome, paused, createdAt: now };
    outcome.then(
      (value) => (parked.settled = { value }),
      (error: unknown) => (parked.settled = { value: errorResult(error) }),
    );
    this.cells.set(handle, parked);
    return paused;
  }

  has(handle: string): boolean {
    return this.cells.has(handle);
  }

  /** The cell's result once it finishes within waitMs, or its Paused again. */
  async resume(handle: string, waitMs: number): Promise<unknown> {
    const parked = this.cells.get(handle);
    if (!parked) return errorResult(new Error(`Unknown or expired handle ${handle}`));
    if (!parked.settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        parked.outcome.catch(() => undefined),
        new Promise((resolve) => (timer = setTimeout(resolve, waitMs))),
      ]);
      clearTimeout(timer);
      // Let the outcome's own settle handler run first.
      await Promise.resolve();
    }
    if (!parked.settled) return pausedResult(parked.paused);
    this.cells.delete(handle);
    return parked.settled.value;
  }

  sweep(now = Date.now()): void {
    for (const [handle, parked] of this.cells)
      if (now - parked.createdAt >= PARK_MAX_MS) this.cells.delete(handle);
  }
}

export function errorResult(error: unknown): Json {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export interface CellDeps {
  /** Runs the cell to its end (through the daemon). */
  run: (signal: AbortSignal) => Promise<unknown>;
  /** Resolves when a hand-off is pending in Chrome; undefined once stopped. */
  watchHandoff: (signal: AbortSignal) => Promise<Handoff | undefined>;
  /** Watches for the hand-off to clear; resolves when it has. */
  watchCleared?: (signal: AbortSignal) => Promise<void>;
}

export interface CellHooks {
  /** A task-augmented call: the task goes input_required while parked instead of returning. */
  onPause?: (message: string) => void;
  onResume?: () => void;
  signal?: AbortSignal;
}

/** browser_code with parking: done or error as usual, or Paused when a hand-off blocks it. */
export async function runParkableCell(
  lot: ParkingLot,
  deps: CellDeps,
  hooks: CellHooks = {},
): Promise<unknown> {
  const stop = new AbortController();
  const abort = () => stop.abort();
  hooks.signal?.addEventListener("abort", abort, { once: true });
  // The cell keeps running after a Paused return; only the caller's own cancel stops it.
  const outcome = deps.run(hooks.signal ?? new AbortController().signal);
  const finished = outcome.then(
    () => undefined,
    () => undefined,
  );
  try {
    for (;;) {
      const handoff = await Promise.race([finished, deps.watchHandoff(stop.signal)]);
      if (!handoff) return await outcome;
      if (!hooks.onPause) return pausedResult(lot.park(outcome, handoff));
      hooks.onPause(pausedLine(handoff.why));
      await Promise.race([finished, deps.watchCleared?.(stop.signal) ?? finished]);
      hooks.onResume?.();
    }
  } finally {
    stop.abort();
    hooks.signal?.removeEventListener("abort", abort);
  }
}

interface TabRow {
  target?: { tabId?: number };
  title?: string;
  handoff?: { message?: string; kind?: string };
}

/** The first pending hand-off in a tab listing. */
export function pendingHandoff(tabs: unknown): Handoff | undefined {
  if (!Array.isArray(tabs)) return undefined;
  for (const tab of tabs as TabRow[])
    if (tab?.handoff)
      return {
        why: String(tab.handoff.message ?? ""),
        ...(tab.handoff.kind ? { kind: tab.handoff.kind } : {}),
        tab: tab.target?.tabId !== undefined ? `t${tab.target.tabId}` : "",
        title: tab.title ?? "",
      };
  return undefined;
}

export const HANDOFF_TABS_CODE = `(await browser.tabs()).filter((tab) => tab.handoff).map((tab) => ({ target: tab.target, title: tab.title, handoff: tab.handoff }))`;

/** Polls `list` until it shows a hand-off (or no longer does, with `cleared`). */
export async function pollHandoff(
  list: () => Promise<unknown>,
  signal: AbortSignal,
  options: { cleared?: boolean; everyMs?: number; firstMs?: number } = {},
): Promise<Handoff | undefined> {
  const every = options.everyMs ?? 1000;
  let wait = options.firstMs ?? every;
  while (!signal.aborted) {
    await sleep(wait, signal);
    wait = every;
    if (signal.aborted) return undefined;
    const found = pendingHandoff(await list().catch(() => []));
    if (options.cleared ? !found : found) return found ?? { why: "" };
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
