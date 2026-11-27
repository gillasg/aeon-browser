import { readFile } from "node:fs/promises";
import {
  BrowserNotConnected,
  useBrowser,
  type Bridge,
  type ModelLike,
} from "@browserkit/tools/site-to-api";
import { configureCliHost } from "browserkit/dist/host.js";
import { GraftClient } from "./client.js";
import { cellErrorMessage, journalPath, offline, runCellOn, type BrowserCell } from "./cell-run.js";

// What browserkit's commands need from Graft: the browser is the user's Chrome, reached through
// the daemon's executor (the same runtime browser_code uses), and the model is Graft's default.
// Both connect only when a command actually needs them, so `graft sites`, `graft call --transport
// direct` and plain-HTTP reads work with Graft closed, exactly like browserkit's own command line.

type Json = Record<string, unknown>;
export type { BrowserCell } from "./cell-run.js";

export class DaemonHost {
  private client: GraftClient | undefined;
  private connecting: Promise<GraftClient> | undefined;
  private browserUsed = false;
  /** `--browser <name>` on any command: every cell it runs goes to that Chrome profile. */
  private pinnedBrowser: string | undefined;

  /** Sends cells without their own `browser` to the named profile (a name from graft browsers). */
  pinBrowser(name: string | undefined): void {
    this.pinnedBrowser = name || undefined;
  }

  get browser(): string | undefined {
    return this.pinnedBrowser;
  }

  connect(): Promise<GraftClient> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= GraftClient.connect().then(
      (client) => {
        this.client = client;
        return client;
      },
      (error: unknown) => {
        this.connecting = undefined;
        throw error;
      },
    );
    return this.connecting;
  }

  /** Runs browser code; throws with the cell's error so commands see what the page said. */
  async runInBrowser(
    code: string,
    options: { session?: string; timeoutMs?: number; browser?: string } = {},
  ): Promise<unknown> {
    return (await this.runCell(code, options)).value;
  }

  /** The whole cell: its value and what it logged. A failed cell throws with its log attached. */
  async runCell(
    code: string,
    options: { session?: string; timeoutMs?: number; browser?: string } = {},
  ): Promise<BrowserCell> {
    // A plain-HTTP read closes the crawler's tab when it is done; there is no tab and no reason
    // to reach the daemon for it. Only the crawler's own cleanup code looks like this.
    if (!this.browserUsed && code.startsWith("if (globalThis.__crawlTab)")) return { value: true };
    this.browserUsed = true;
    const browser = options.browser ?? this.pinnedBrowser;
    const result = await runCellOn(await this.connect(), code, {
      ...options,
      ...(browser ? { browser } : {}),
    });
    if (result.error) throw Object.assign(browserError(result), { output: result.output });
    return result;
  }

  /** Graft's default model, as site-to-api and browser-crawl expect one. */
  model(): ModelLike {
    return {
      complete: (async (context: {
        systemPrompt: string;
        messages: unknown[];
        tools: unknown[];
      }) => {
        const client = await this.connect();
        const reply = await client.modelComplete(context);
        if (reply.error) throw new Error(String(reply.error));
        return reply.message;
      }) as ModelLike["complete"],
    };
  }

  async blocked(
    action: "read" | "add" | "remove",
    site?: string,
  ): Promise<{ sites: string[]; error?: string }> {
    const client = await this.connect();
    const reply = await client.blocked({ action, ...(site ? { site } : {}) });
    return {
      sites: (reply.sites as string[] | undefined) ?? [],
      ...(reply.error ? { error: String(reply.error) } : {}),
    };
  }

  async film(action: "arm" | "disarm" | "read" | "clear"): Promise<Json> {
    return (await this.connect()).film(action);
  }

  async browsers(rename?: { browser: string; name: string }): Promise<Json> {
    return (await this.connect()).browsers(rename);
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
    this.connecting = undefined;
  }
}

function browserError(result: BrowserCell): Error {
  const message = cellErrorMessage(result);
  if (!offline(result)) return new Error(message);
  // The site-to-api class carries the browser-offline exit code; the message says how Graft recovers.
  const error = new BrowserNotConnected(message);
  error.message = message;
  return error;
}

/** The bridge site-to-api and browser-crawl use for their browser calls. */
export function daemonBridge(host: DaemonHost): Bridge {
  return {
    run: (code, options) => host.runInBrowser(code, options ?? {}),
    status: () => Promise.resolve({ browsers: 1 }),
    close: () => undefined,
  };
}

/** Routes every browser call in this process through Graft, and installs the CLI host. */
export function installGraftCliHost(host: DaemonHost): void {
  useBrowser(daemonBridge(host));
  configureCliHost({
    runInBrowser: (code, options) => host.runInBrowser(code, options ?? {}),
    browsers: () => host.browsers(),
    model: async () => host.model(),
  });
}

export { journalPath };

export async function readJournal(
  session: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const text = await readFile(journalPath(), "utf8").catch(() => undefined);
  if (text === undefined) return [];
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Json;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is Json => !!entry)
    .filter((entry) => !session || entry.session === session)
    .slice(-limit);
}
