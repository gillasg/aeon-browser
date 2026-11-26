import type { AeonClient } from "./client.js";
import { cellErrorMessage, runCellOn } from "./cell-run.js";
import type { TapFrame, TapKind, TapSource } from "./mcp-tap-stream.js";

// The live browser behind aeon/tap: the engine's own page.streams tap in the connected Chrome,
// driven over the daemon. Installing a tab starts its tap (WebRTC only when asked); a pump waits
// on the engine's ring and forwards new frames; removing the last kind stops the tap, which
// restores the page's originals and turns Runtime off when nothing else on the tab needs it.

/** Runs one browser cell and returns its value; throws with the cell's error. */
export type CellRunner = (code: string, timeoutMs: number) => Promise<unknown>;
const WAIT_MS = 20_000;
const RETRY_MS = 1_000;
const MAX_FAILURES = 3;

interface TabTap {
  kinds: Set<TapKind>;
  since: number;
  pumping: boolean;
}
interface EngineFrame {
  seq: number;
  at: number;
  url: string;
  kind: TapKind;
  direction: "received" | "sent";
  data: string;
  json?: unknown;
}

export function cellRunner(aeon: () => Promise<AeonClient>, session = "mcp-tap"): CellRunner {
  return async (code, timeoutMs) => {
    const result = await runCellOn(await aeon(), code, { session, timeoutMs });
    if (result.error) throw new Error(cellErrorMessage(result));
    return result.value;
  };
}

export class BrowserTapSource implements TapSource {
  private readonly tabs = new Map<number, TabTap>();
  private readonly listeners = new Set<(frame: TapFrame) => void>();

  constructor(private readonly run: CellRunner) {}

  async resolveTab(ref: number | undefined): Promise<number> {
    if (ref !== undefined) return ref;
    const id = Number(await this.run("return (await browser.activeTab()).id;", 10_000));
    if (!Number.isInteger(id)) throw new Error("aeon/tap: no active tab to watch.");
    return id;
  }

  async install(tab: number, kind: TapKind): Promise<void> {
    const entry = this.tabs.get(tab) ?? { kinds: new Set(), since: 0, pumping: false };
    this.tabs.set(tab, entry);
    entry.kinds.add(kind);
    const started = (await this.run(
      `const p = await browser.tab(${tab}); await p.streams.start({webrtc: ${entry.kinds.has("webrtc")}}); return (await p.streams.list({})).at(-1)?.seq ?? 0;`,
      15_000,
    )) as number;
    if (!entry.pumping) {
      entry.since = Number(started) || 0;
      void this.pump(tab, entry);
    }
  }

  async remove(tab: number, kind: TapKind): Promise<void> {
    const entry = this.tabs.get(tab);
    if (!entry) return;
    entry.kinds.delete(kind);
    if (!entry.kinds.size) this.tabs.delete(tab);
    // Stopping restores the originals; a remaining ws/sse watch restarts without the page script.
    const restart = entry.kinds.size && kind === "webrtc" ? "await p.streams.start({});" : "";
    if (entry.kinds.size && !restart) return;
    await this.run(
      `const p = await browser.tab(${tab}); await p.streams.stop(); ${restart} return true;`,
      15_000,
    );
  }

  onFrame(listener: (frame: TapFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits on the engine's ring (event-driven there) and forwards every new frame. */
  private async pump(tab: number, entry: TabTap): Promise<void> {
    entry.pumping = true;
    let failures = 0;
    while (this.tabs.get(tab) === entry) {
      try {
        const frames = (await this.run(
          `const p = await browser.tab(${tab}); const s = ${entry.since}; if (!(await p.streams.waitFor({since: s}, ${WAIT_MS}))) return []; return p.streams.list({since: s});`,
          WAIT_MS + 10_000,
        )) as EngineFrame[] | null;
        failures = 0;
        for (const frame of frames ?? []) {
          entry.since = Math.max(entry.since, frame.seq);
          if (this.tabs.get(tab) === entry && entry.kinds.has(frame.kind)) this.emit(tab, frame);
        }
      } catch {
        if (++failures >= MAX_FAILURES) break;
        await new Promise((done) => setTimeout(done, RETRY_MS).unref());
      }
    }
    entry.pumping = false;
  }

  private emit(tab: number, frame: EngineFrame): void {
    const out: TapFrame = {
      tab,
      kind: frame.kind,
      dir: frame.direction === "sent" ? "out" : "in",
      url: frame.url,
      data: frame.json ?? frame.data,
      at: frame.at,
    };
    for (const listener of this.listeners) listener(out);
  }
}
