// Webhook deliveries waiting for their next try, kept in the daemon's data directory so a restart
// does not drop them. One try at once, then 10 s, 1 m, 5 m, 30 m and 2 h later, then given up.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

export interface QueuedDelivery {
  id: string;
  url: string;
  secret: string | null;
  body: string;
  attempts: number;
  nextAt: number;
}

export type Outcome = { delivered: true } | { delivered: false; error: string };

export interface QueueClock {
  now(): number;
  setTimer(run: () => unknown, ms: number): { cancel(): void };
}

export const realClock: QueueClock = {
  now: () => Date.now(),
  setTimer(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

interface Row {
  id: string;
  url: string;
  secret: string | null;
  body: string;
  attempts: number;
  next_at: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS webhook_queue (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT, body TEXT NOT NULL,
  attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, last_error TEXT)`;

export class WebhookQueue {
  private readonly db: Database.Database;
  private timer: { cancel(): void } | undefined;
  private running = false;

  constructor(
    file: string,
    private readonly send: (item: QueuedDelivery) => Promise<Outcome>,
    private readonly clock: QueueClock = realClock,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    if (file !== ":memory:") mkdirSync(join(file, ".."), { recursive: true });
    this.db = new Database(file);
    this.db.exec(SCHEMA);
    this.schedule();
  }

  /** Stores the delivery and tries it at once, without waiting for the answer. */
  add(item: Omit<QueuedDelivery, "attempts" | "nextAt">): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO webhook_queue (id, url, secret, body, attempts, next_at) VALUES (?, ?, ?, ?, 0, ?)",
      )
      .run(item.id, item.url, item.secret, item.body, this.clock.now());
    this.schedule(0);
  }

  pending(): QueuedDelivery[] {
    const rows = this.db.prepare("SELECT * FROM webhook_queue ORDER BY next_at").all() as Row[];
    return rows.map(fromRow);
  }

  close(): void {
    this.timer?.cancel();
    this.db.close();
  }

  private schedule(delay?: number): void {
    this.timer?.cancel();
    const next = this.db.prepare("SELECT MIN(next_at) AS at FROM webhook_queue").get() as {
      at: number | null;
    };
    if (next.at === null) return;
    const wait = delay ?? Math.max(0, next.at - this.clock.now());
    this.timer = this.clock.setTimer(() => this.drain(), wait);
  }

  /** Tries everything that is due, then waits for the next one. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.db
        .prepare("SELECT * FROM webhook_queue WHERE next_at <= ? ORDER BY next_at")
        .all(this.clock.now()) as Row[];
      for (const row of due) await this.tryOne(fromRow(row));
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async tryOne(item: QueuedDelivery): Promise<void> {
    const outcome = await this.send(item).catch((error: unknown): Outcome => ({
      delivered: false,
      error: String(error),
    }));
    const attempts = item.attempts + 1;
    const delay = RETRY_DELAYS_MS[attempts - 1];
    if (outcome.delivered || delay === undefined) {
      this.db.prepare("DELETE FROM webhook_queue WHERE id = ?").run(item.id);
      this.log(
        outcome.delivered
          ? `webhook ${item.id} delivered after ${attempts} tries`
          : `webhook ${item.id} gave up after ${attempts} tries: ${outcome.error}`,
      );
      return;
    }
    this.log(`webhook ${item.id} try ${attempts} failed: ${outcome.error}; next in ${delay} ms`);
    this.db
      .prepare("UPDATE webhook_queue SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?")
      .run(attempts, this.clock.now() + delay, outcome.error.slice(0, 500), item.id);
  }
}

function fromRow(row: Row): QueuedDelivery {
  const { next_at: nextAt, ...rest } = row;
  return { ...rest, nextAt };
}
