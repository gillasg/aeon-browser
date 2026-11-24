// Hosts one browser_code realm per ACTIVE chat and relays its browser calls to the extension.
// A long browser.job (many pages) gets its own realm and stays alive after its cell returns.
// A realm holds the chat's REPL variables, so dropping it at the end of a run would lose them;
// instead keep a small LRU working set and evict realms that have not run a cell in a while.
import { CodeRealm } from "./code-realm.js";
import { jobSource } from "./code-job-source.js";

/** The extension side: `event` sends one realm event and resolves with the extension's answer. */
export interface RealmLink {
  event(message: Record<string, unknown>): Promise<unknown>;
}
interface Realm {
  realm: CodeRealm;
  usedAt: number;
}
interface JobRealm extends Realm {
  chatId: string;
  busy: boolean;
  startedAt: number;
}
interface Cell {
  chatId: string;
  startedAt: number;
  reply: (value: unknown) => void;
}
// A chat can pause for minutes while the model thinks; its REPL must survive that. Evict only
// after a long idle, and keep a small working set so many chats cannot pin many realms.
const MAX_REALMS = 4;
const MAX_JOB_REALMS = 2;
const REALM_IDLE_MS = 20 * 60_000;
const CELL_MAX_MS = 10 * 60_000;
const SWEEP_MS = 30_000;
const DROPPED_JOB = "the worker dropped this job before it finished; start it again";

export class RealmHost {
  private readonly realms = new Map<string, Realm>();
  private readonly jobRealms = new Map<string, JobRealm>();
  private readonly cells = new Map<string, Cell>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly link: RealmLink) {}

  /** The realm an unhandled rejection came from, if any. */
  noteRejection(promise: unknown, reason: unknown): boolean {
    for (const item of [...this.realms.values(), ...this.jobRealms.values()])
      if (item.realm.owns(promise)) {
        item.realm.noteRejection(reason);
        return true;
      }
    return false;
  }

  /** Test seam: the number of live realms (chat realms plus job realms). */
  realmCount(): number {
    return this.realms.size + this.jobRealms.size;
  }

  stopSweep(): void {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /** One operation from the extension: the same kinds the offscreen document took. */
  handle(message: Record<string, unknown>): Promise<unknown> | unknown {
    const chatId = String(message.chatId ?? "");
    switch (message.kind) {
      case "ping":
        return { ok: true };
      case "reset":
        this.drop(chatId);
        return true;
      case "interrupt":
        // Stop the cell and keep the realm, so a deadline can return the value built so far.
        this.realms.get(chatId)?.realm.receive({ kind: "stop", keep: true });
        return true;
      case "job":
        return this.startJob(
          String(message.jobId),
          chatId,
          jobSource((message.spec ?? {}) as Record<string, unknown>),
        );
      case "stopJobs":
        for (const [jobId, job] of this.jobRealms)
          if (job.chatId === chatId && (!message.jobId || message.jobId === jobId)) {
            job.realm.dispose();
            this.jobRealms.delete(jobId);
          }
        return true;
      case "cell":
        return this.startCell(message, chatId);
      default:
        return { error: `UNSUPPORTED: realm operation ${String(message.kind)}` };
    }
  }

  private startJob(jobId: string, chatId: string, code: string): boolean {
    const target = this.jobRealm(jobId, chatId);
    target.busy = true;
    target.usedAt = Date.now();
    target.startedAt = target.usedAt;
    target.realm.receive({ kind: "cell", cellId: jobId, code });
    return true;
  }

  private startCell(message: Record<string, unknown>, chatId: string): Promise<unknown> {
    const cellId = String(message.cellId);
    const target = this.realm(chatId);
    return new Promise((reply) => {
      this.cells.set(cellId, { chatId, startedAt: Date.now(), reply });
      this.stage(cellId, "offscreen");
      this.stage(cellId, "realm-ready");
      target.realm.receive({
        kind: "cell",
        cellId,
        code: message.code,
        attached: message.attached,
        timeoutMs: message.timeoutMs,
      });
    });
  }

  private makeRealm(post: (message: Record<string, unknown>) => void): CodeRealm {
    return new CodeRealm(post);
  }

  private realm(chatId: string): Realm {
    const existing = this.realms.get(chatId);
    if (existing) {
      existing.usedAt = Date.now();
      return existing;
    }
    const created: Realm = { realm: undefined as unknown as CodeRealm, usedAt: Date.now() };
    created.realm = this.makeRealm((message) => this.fromRealm(created.realm, message));
    this.realms.set(chatId, created);
    this.scheduleSweep();
    return created;
  }

  private jobRealm(jobId: string, chatId: string): JobRealm {
    const existing = this.jobRealms.get(jobId);
    if (existing) {
      existing.usedAt = Date.now();
      return existing;
    }
    const now = Date.now();
    const created: JobRealm = {
      realm: undefined as unknown as CodeRealm,
      usedAt: now,
      chatId,
      busy: false,
      startedAt: now,
    };
    created.realm = this.makeRealm((message) => this.fromRealm(created.realm, message));
    this.jobRealms.set(jobId, created);
    this.scheduleSweep();
    return created;
  }

  /** A chat with a cell in flight owns its realm; never evict one that still has work to answer. */
  private hasCell(chatId: string): boolean {
    for (const cell of this.cells.values()) if (cell.chatId === chatId) return true;
    return false;
  }

  /**
   * Bound the working set: idle realms go after REALM_IDLE_MS, and the least recently used go
   * first past MAX_REALMS. Jobs in flight are busy through their own `done`, so they are never
   * evicted. The sweep timer calls this and stops itself when nothing is left.
   */
  sweepRealms(now = Date.now()): void {
    this.sweepJobs(now);
    for (const [chatId, existing] of this.realms) {
      if (this.hasCell(chatId)) {
        existing.usedAt = now;
        continue;
      }
      if (now - existing.usedAt >= REALM_IDLE_MS) this.drop(chatId);
    }
    // Then cap: past MAX_REALMS drop the least recently used idle chats. A chat with a cell in
    // flight keeps its REPL; dropping that would break the run, so the cap only binds at rest.
    const excess = this.realms.size - MAX_REALMS;
    if (excess > 0) {
      const lru = [...this.realms]
        .filter(([id]) => !this.hasCell(id))
        .sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [chatId] of lru.slice(0, excess)) if (this.realms.has(chatId)) this.drop(chatId);
    }
    // A cell that never got a `done` (a deadline passed in the extension) must not pin a realm
    // or accumulate reply callbacks for the life of the process.
    for (const [cellId, cell] of this.cells)
      if (now - cell.startedAt >= CELL_MAX_MS) {
        this.cells.delete(cellId);
        cell.reply({ output: "", error: "TIMEOUT: browser cell did not finish" });
      }
    if (!this.realms.size && !this.jobRealms.size && !this.cells.size) this.stopSweep();
  }

  private sweepJobs(now: number): void {
    for (const [jobId, job] of this.jobRealms) {
      // A job whose cell never answered (its deadline passed in the extension) is no longer
      // busy; otherwise one abandoned job pins its realm for the life of the process.
      if (job.busy && (now - job.startedAt >= CELL_MAX_MS || now - job.usedAt >= REALM_IDLE_MS))
        job.busy = false;
      if (!job.busy && now - job.usedAt >= REALM_IDLE_MS) this.forgetJob(jobId, job, DROPPED_JOB);
    }
    const jobExcess = this.jobRealms.size - MAX_JOB_REALMS;
    if (jobExcess > 0) {
      const lruJobs = [...this.jobRealms]
        .filter(([, job]) => !job.busy)
        .sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [jobId, job] of lruJobs.slice(0, jobExcess))
        this.forgetJob(jobId, job, DROPPED_JOB);
    }
  }

  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined) return;
    this.sweepTimer = setInterval(() => this.sweepRealms(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** Tell the extension how far this cell got, for the deadline error. */
  private stage(cellId: string, value: string): void {
    if (!this.cells.has(cellId)) return;
    void this.link.event({ kind: "stage", cellId, stage: value }).catch(() => undefined);
  }

  /** Removes a job realm and tells the extension, so status is "lost" with a reason. */
  private forgetJob(jobId: string, job: JobRealm, reason: string): void {
    job.realm.dispose();
    this.jobRealms.delete(jobId);
    void this.link
      .event({ kind: "jobLost", jobId, chatId: job.chatId, error: reason })
      .catch(() => undefined);
  }

  private drop(chatId: string): void {
    this.realms.get(chatId)?.realm.dispose();
    this.realms.delete(chatId);
    for (const [jobId, job] of this.jobRealms)
      if (job.chatId === chatId) this.forgetJob(jobId, job, DROPPED_JOB);
    for (const [cellId, cell] of this.cells)
      if (cell.chatId === chatId) {
        this.cells.delete(cellId);
        cell.reply({ output: "", error: "RUN_RESET: browser runtime reset", reset: true });
      }
  }

  private owner(realm: CodeRealm): { chatId?: string; jobId?: string } | undefined {
    for (const [chatId, item] of this.realms) if (item.realm === realm) return { chatId };
    for (const [jobId, item] of this.jobRealms)
      if (item.realm === realm) return { chatId: item.chatId, jobId };
    return undefined;
  }

  private fromRealm(realm: CodeRealm, message: Record<string, unknown>): void {
    const owner = this.owner(realm);
    if (!owner || typeof message.cellId !== "string") return;
    if (message.kind === "call") return this.relayCall(realm, message);
    if (message.kind === "done" && owner.jobId) return this.jobDone(owner, message);
    if (message.kind === "started") return this.stage(message.cellId, "evaluating");
    if (message.kind !== "done") return;
    const cell = this.cells.get(message.cellId);
    if (!cell || cell.chatId !== owner.chatId) return;
    this.stage(message.cellId, "result-sent");
    this.cells.delete(message.cellId);
    cell.reply({
      value: message.value,
      output: message.output,
      error: message.error,
      ...(Array.isArray(message.screenshots) ? { screenshots: message.screenshots } : {}),
    });
  }

  private relayCall(realm: CodeRealm, message: Record<string, unknown>): void {
    void this.link
      .event({ kind: "call", cellId: message.cellId, request: message.request })
      .then(
        (response) =>
          (response as { value?: unknown; error?: string } | undefined) ?? {
            error: "Browser host unavailable",
          },
        (error: unknown) => ({ error: String(error instanceof Error ? error.message : error) }),
      )
      .then((response) => realm.receive({ kind: "reply", callId: message.callId, ...response }));
  }

  private jobDone(owner: { chatId?: string; jobId?: string }, message: Record<string, unknown>) {
    const jobId = String(owner.jobId);
    this.jobRealms.get(jobId)?.realm.dispose();
    this.jobRealms.delete(jobId);
    void this.link
      .event({
        kind: "jobDone",
        jobId,
        value: message.value,
        output: message.output,
        ...(message.error ? { error: message.error } : {}),
        chatId: owner.chatId,
      })
      .catch(() => undefined);
  }
}
