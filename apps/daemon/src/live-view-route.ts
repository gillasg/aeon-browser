// Live viewers as a daemon feature: browser code (`browser.liveView`), the CLI (`graft live`) and
// boosts (through the extension background) start, list, feed and stop them here. Each viewer is
// its own loopback server with its own token; all of them close when the daemon stops, and one
// nobody pushed to or watched for two hours closes by itself.
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { startLiveView, type LiveView } from "./live-view.js";

export const LIVE_VIEW_IDLE_MS = 2 * 60 * 60_000;
const SWEEP_MS = 60_000;
const MAX_VIEWS = 16;

export interface LiveViewHandle {
  id: string;
  title: string;
  /** The link to open: carries the read token in its fragment. */
  url: string;
  pushUrl: string;
  token: string;
}

export interface LiveViewSummary {
  id: string;
  title: string;
  url: string;
  rows: number;
  frames: number;
  startedAt: number;
  lastActivityAt: number;
}

interface Entry {
  id: string;
  view: LiveView;
  startedAt: number;
}

export class LiveViewHub {
  private readonly views = new Map<string, Entry>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly idleMs = LIVE_VIEW_IDLE_MS,
    private readonly now = () => Date.now(),
  ) {}

  async start(options: { title?: unknown } = {}): Promise<LiveViewHandle> {
    if (this.views.size >= MAX_VIEWS)
      throw new Error(
        `LIVE_VIEW_LIMIT: ${MAX_VIEWS} viewers are open; stop one with liveView.stop(id)`,
      );
    const title = typeof options.title === "string" && options.title.trim() ? options.title : "";
    const view = await startLiveView({
      now: this.now,
      ...(title ? { title: title.slice(0, 200) } : {}),
    });
    const id = randomUUID().slice(0, 8);
    this.views.set(id, { id, view, startedAt: this.now() });
    this.sweeper ??= setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
    return handle(id, view);
  }

  async stop(id: string): Promise<boolean> {
    const entry = this.views.get(id);
    if (!entry) return false;
    this.views.delete(id);
    await entry.view.close();
    if (!this.views.size) this.stopSweeper();
    return true;
  }

  list(): LiveViewSummary[] {
    return [...this.views.values()].map(({ id, view, startedAt }) => {
      const state = view.snapshot();
      return {
        id,
        title: state.title,
        url: view.viewerUrl,
        rows: state.rows.length,
        frames: state.frames.length,
        startedAt,
        lastActivityAt: view.lastActivity(),
      };
    });
  }

  /** Closes viewers idle longer than the limit; returns the ids it closed. */
  async sweep(): Promise<string[]> {
    const idle = [...this.views.values()]
      .filter((entry) => this.now() - entry.view.lastActivity() > this.idleMs)
      .map((entry) => entry.id);
    for (const id of idle) await this.stop(id);
    return idle;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.views.keys()];
    for (const id of ids) await this.stop(id);
    this.stopSweeper();
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}

function handle(id: string, view: LiveView): LiveViewHandle {
  return {
    id,
    title: view.snapshot().title,
    url: view.viewerUrl,
    pushUrl: view.pushUrl,
    token: view.token,
  };
}

/** The daemon's one hub. */
export const liveViews = new LiveViewHub();

type Request = Record<string, unknown>;

export function isLiveViewRequest(value: unknown): value is { liveView: string } & Request {
  return typeof (value as { liveView?: unknown } | null)?.liveView === "string";
}

/** `{liveView: 'start'|'stop'|'list', ...}` from browser code or the CLI. */
export async function liveViewCall(request: Request, hub = liveViews): Promise<unknown> {
  const action = String(request.liveView);
  if (action === "start") return hub.start({ title: request.title });
  if (action === "stop") {
    const id = String(request.id ?? "");
    return { id, stopped: await hub.stop(id) };
  }
  if (action === "list") return hub.list();
  throw new Error(`UNSUPPORTED: liveView.${action}; use start, stop or list`);
}

/** `graft live ...` over the core socket: `{kind: "core.live", requestId, liveView, ...}`. */
export function handleCoreLive(socket: WebSocket, candidate: unknown, hub = liveViews): boolean {
  const request = candidate as Request | null;
  if (request?.kind !== "core.live" || typeof request.requestId !== "string") return false;
  if (!isLiveViewRequest(request)) return false;
  const requestId = request.requestId;
  const send = (body: Request) =>
    socket.send(JSON.stringify({ kind: "core.live.result", requestId, ...body }));
  liveViewCall(request, hub).then(
    (result) => send({ result }),
    (error: unknown) => send({ error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}
