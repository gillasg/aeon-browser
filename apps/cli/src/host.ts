import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BrowserNotConnected,
  useBrowser,
  type Bridge,
  type ModelLike,
} from "@browserkit/tools/site-to-api";
import { configureCliHost } from "browserkit/dist/host.js";
import { AeonClient, dataDirectory } from "./client.js";

// What browserkit's commands need from Aeon: the browser is the user's Chrome, reached through
// the daemon's executor (the same runtime browser_code uses), and the model is Aeon's default.
// Both connect only when a command actually needs them, so `aeon sites`, `aeon call --transport
// direct` and plain-HTTP reads work with Aeon closed, exactly like browserkit's own command line.

type Json = Record<string, unknown>;
export interface BrowserCell {
  value?: unknown;
  output?: string;
  error?: string;
  detail?: string;
}

export class DaemonHost {
  private client: AeonClient | undefined;
  private connecting: Promise<AeonClient> | undefined;
  private browserUsed = false;

  connect(): Promise<AeonClient> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= AeonClient.connect().then(
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
    options: { session?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    // A plain-HTTP read closes the crawler's tab when it is done; there is no tab and no reason
    // to reach the daemon for it. Only the crawler's own cleanup code looks like this.
    if (!this.browserUsed && code.startsWith("if (globalThis.__crawlTab)")) return true;
    this.browserUsed = true;
    const session = options.session ?? "cli";
    const started = Date.now();
    const client = await this.connect();
    const result = (await client.browserRun({
      code,
      session,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    })) as BrowserCell;
    await this.record(session, result, Date.now() - started);
    if (result.error) throw browserError(result);
    return result.value;
  }

  /** Aeon's default model, as site-to-api and browser-crawl expect one. */
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

  close(): void {
    this.client?.close();
    this.client = undefined;
    this.connecting = undefined;
  }

  private async record(session: string, result: BrowserCell, durationMs: number): Promise<void> {
    const preview =
      result.error ??
      result.detail ??
      stringify(result.value) ??
      result.output?.slice(0, 200) ??
      "";
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session,
      isError: Boolean(result.error),
      durationMs,
      resultPreview: preview.slice(0, 200),
    });
    const file = journalPath();
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, line + "\n").catch(() => undefined);
  }
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return String(value);
  }
}

function browserError(result: BrowserCell): Error {
  const code = result.error ?? "OPERATION_FAILED";
  if (code === "BROWSER_OFFLINE" || code === "AMBIGUOUS_BROWSER") {
    const detail =
      code === "AMBIGUOUS_BROWSER"
        ? "Several browsers are connected. Attach a tab from the intended one first."
        : "Aeon's browser is not connected.";
    // The site-to-api class carries the browser-offline exit code; say how Aeon recovers instead.
    const error = new BrowserNotConnected(detail);
    error.message = `${detail} Open Chrome with Aeon loaded, then retry.`;
    return error;
  }
  return new Error(result.detail ? `${code}: ${result.detail}` : code);
}

/** The bridge site-to-api and browser-crawl use for their browser calls. */
export function daemonBridge(host: DaemonHost): Bridge {
  return {
    run: (code, options) => host.runInBrowser(code, options ?? {}),
    status: () => Promise.resolve({ browsers: 1 }),
    close: () => undefined,
  };
}

/** Routes every browser call in this process through Aeon, and installs the CLI host. */
export function installAeonCliHost(host: DaemonHost): void {
  useBrowser(daemonBridge(host));
  configureCliHost({
    runInBrowser: (code, options) => host.runInBrowser(code, options ?? {}),
    model: async () => host.model(),
  });
}

export const journalPath = (): string => join(dataDirectory(), "cli-journal.jsonl");

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
