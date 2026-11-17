// Writes that are safe to retry. A write remembers each key it ran under for a day (or the old
// receipt's ttlDays), so the same key never applies twice. A failure carries a code, whether the
// change may have reached the site (`write_status`, `possible_commit`) and what a retry needs
// (`retry`), and the runner never falls through to another way once one may have applied. A write
// can read the site back afterwards to confirm the change.

import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { abilityDirectory, type Ability } from "./abilities.js";
import { writeAtomic } from "./registry.js";

export type WriteStatus = "not_attempted" | "not_applied" | "may_have_applied" | "applied";
/**
 * never: check the outcome first and do not repeat the call as is. An unanswered write is never:
 * the error names the read-back, and a new key is not a retry. fix_input: correct the input or
 * the login, then call again. same_key: the call may be repeated as is.
 */
export type RetryClass = "never" | "fix_input" | "same_key" | "new_key";

/** Said whenever a write may already have reached the site. */
export const READ_BACK_NOTE =
  "read the site back, and call again with a new key only if the change is absent.";
export type OutcomeCode =
  | "input_rejected"
  | "credentials_rejected"
  | "input_not_applied"
  | "no_response"
  | "outcome_unknown"
  | "execution_failed";

export interface WriteOutcome {
  code: OutcomeCode;
  write_status: WriteStatus;
  possible_commit: boolean;
  retry: RetryClass;
}

export interface ReadBack {
  /** A read ability on the same site. */
  ability: string;
  inputs?: Record<string, unknown>;
  /** Values (templated from the write's inputs) the read result must contain. */
  expect?: Record<string, unknown>;
}

export class AbilityWriteError extends Error {
  constructor(
    message: string,
    readonly outcome: WriteOutcome,
  ) {
    super(`${message} ${JSON.stringify(outcome)}`);
    this.name = "AbilityWriteError";
  }
}

interface KeyEntry {
  write_status: WriteStatus;
  at: string;
  result?: unknown;
}

type KeyFile = Record<string, Record<string, KeyEntry>>;

const KEYS = ".write-keys.json";
const DAY = 86_400_000;

function keyPath(site: string): string {
  return join(abilityDirectory(site), KEYS);
}

async function readKeys(site: string): Promise<KeyFile> {
  try {
    return JSON.parse(await readFile(keyPath(site), "utf8")) as KeyFile;
  } catch {
    return {};
  }
}

function keyTtl(ability: Ability): number {
  const write = ability.options.write as { ttlDays?: number } | undefined;
  return (write?.ttlDays && write.ttlDays > 0 ? write.ttlDays : 1) * DAY;
}

/** The key a write runs under: the caller's, or for old receipt writes, its inputs. */
export function writeKey(
  ability: Ability,
  inputs: Record<string, unknown>,
  key?: string,
): string | undefined {
  if (key) return key;
  if (ability.options.write) return "inputs:" + JSON.stringify(inputs);
  return undefined;
}

export async function findWriteKey(
  ability: Ability,
  key: string,
  now = Date.now(),
): Promise<KeyEntry | undefined> {
  const entry = (await readKeys(ability.site))[ability.name]?.[key];
  if (!entry || now - Date.parse(entry.at) > keyTtl(ability)) return undefined;
  return entry;
}

export async function recordWriteKey(
  ability: Ability,
  key: string,
  entry: Omit<KeyEntry, "at">,
): Promise<void> {
  await withWriteLock(ability.site, () => writeKeyEntry(ability, key, entry));
}

/**
 * Records may_have_applied before the send. The same key, in this process or another, then
 * sees that record and does not send again. An applied key returns its saved result.
 */
export async function claimWriteKey(
  ability: Ability,
  key: string,
): Promise<{ result: unknown } | undefined> {
  return withWriteLock(ability.site, async () => {
    const entry = await findWriteKey(ability, key);
    if (entry) return answerRepeat(ability, key, entry);
    await writeKeyEntry(ability, key, { write_status: "may_have_applied" });
    return undefined;
  });
}

/** Drops an in-flight key after a write that did not reach the site, so the same key can retry. */
export async function releaseWriteKey(ability: Ability, key: string): Promise<void> {
  await withWriteLock(ability.site, async () => {
    const file = await readKeys(ability.site);
    const current = file[ability.name]?.[key];
    if (!current || current.write_status !== "may_have_applied") return;
    const rest = { ...(file[ability.name] ?? {}) };
    delete rest[key];
    file[ability.name] = rest;
    await mkdir(abilityDirectory(ability.site), { recursive: true });
    await writeAtomic(keyPath(ability.site), JSON.stringify(file, null, 2) + "\n");
  });
}

async function writeKeyEntry(
  ability: Ability,
  key: string,
  entry: Omit<KeyEntry, "at">,
): Promise<void> {
  const file = await readKeys(ability.site);
  const now = Date.now();
  const kept = Object.fromEntries(
    Object.entries(file[ability.name] ?? {}).filter(
      ([, value]) => now - Date.parse(value.at) <= keyTtl(ability),
    ),
  );
  file[ability.name] = { ...kept, [key]: { ...entry, at: new Date(now).toISOString() } };
  await mkdir(abilityDirectory(ability.site), { recursive: true });
  await writeAtomic(keyPath(ability.site), JSON.stringify(file, null, 2) + "\n");
}

const keyChains = new Map<string, Promise<unknown>>();

/** One writer at a time for a site's key file, in this process and across processes. */
function withWriteLock<T>(site: string, work: () => Promise<T>): Promise<T> {
  const prior = keyChains.get(site) ?? Promise.resolve();
  const run = prior.then(
    () => withFileLock(site, work),
    () => withFileLock(site, work),
  );
  keyChains.set(
    site,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function withFileLock<T>(site: string, work: () => Promise<T>): Promise<T> {
  const lock = join(abilityDirectory(site), ".write-keys.lock");
  const deadline = Date.now() + 10_000;
  while (!(await takeLock(lock))) {
    if (Date.now() > deadline) throw new Error("WRITE_KEY_LOCK: could not record the write key");
    await wait(5);
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function takeLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT")
      await mkdir(join(lock, ".."), { recursive: true }).catch(() => undefined);
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The answer to a key already used: an applied one returns its result without running again; one
 * that may have applied refuses until the caller has checked the site. Undefined: run it.
 */
export function answerRepeat(
  ability: Ability,
  key: string,
  entry: KeyEntry,
): { result: unknown } | undefined {
  if (entry.write_status === "applied") return { result: entry.result };
  if (entry.write_status === "may_have_applied")
    throw new AbilityWriteError(
      `WRITE_UNCERTAIN: ${ability.site} ${ability.name} under key ${key} may already have applied at ${entry.at}; ` +
        READ_BACK_NOTE,
      {
        code: "outcome_unknown",
        write_status: "may_have_applied",
        possible_commit: true,
        retry: "never",
      },
    );
  return undefined;
}

// PRIVATE_NETWORK means the call was refused before it was sent. A write that was sent and then
// answered with a redirect we did not follow says outcome_unknown and is never retried: the
// change may already have landed, and sending it again would be a second submit.
const NOT_SENT =
  /No (site API transport|browser is attached|workflow runtime)|has no operation|ABILITY_BAD|SITE_BLOCKED|not mapped|\bPRIVATE_NETWORK\b/i;
const SIGNED_OUT = /\b401\b|signed[- ]out|unauthori[sz]ed|session expired|Challenged/i;
const REJECTED = /\b(400|404|405|409|410|422)\b|invalid|required|not allowed|forbidden|\b403\b/i;
const NO_RESPONSE =
  /timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|network|fetch failed|\b50[234]\b/i;

/** What the browser recorded for one commit: the requests it caused, and what the page said. */
export interface CommitReceipt {
  requests?: { method?: string; url?: string; status?: number; error?: string }[];
  lateReply?: string;
  /** A dialog or field error new since the action. */
  dialog?: string;
  /** The page says the change is still processing. */
  processing?: boolean;
  /** Still running when the receipt closed, e.g. "request:/api/order". */
  open?: string[];
}

const SAFE_METHOD = new Set(["GET", "HEAD", "OPTIONS"]);
const REFUSED_STATUS = new Set([400, 403, 404, 405, 409, 410, 422]);
const PROCESSING = /\bprocessing\b/i;

/** The receipt on an action result or a thrown error, when it has one. */
export function commitReceipt(value: unknown): CommitReceipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.receipt;
  if (nested && typeof nested === "object") return asReceipt(nested as Record<string, unknown>);
  if (looksLikeReceipt(record)) return asReceipt(record);
  return undefined;
}

/**
 * A returned commit whose receipt is not a settled success. Undefined when the result can stand.
 * An unanswered or 5xx write, or a page still processing, must not be reported as applied.
 */
export function refuseUnsettled(result: unknown, reachedCommit: boolean): void {
  if (!reachedCommit) return;
  const receipt = commitReceipt(result);
  if (!receipt) return;
  const verdict = receiptVerdict(receipt, "");
  if (!verdict) return;
  const error = new Error(receipt.dialog || verdict.code);
  (error as Error & { receipt?: CommitReceipt }).receipt = receipt;
  throw error;
}

/**
 * How a failed way left the site, from the commit receipt when there is one, else the error text.
 * `reachedCommit` stays false through steps marked as settings: they only change a choice and spend
 * nothing, so a refusal after just those settles not_applied and leaves the retry key free.
 */
export function classifyFailure(
  error: unknown,
  reachedCommit: boolean,
  receipt?: CommitReceipt,
): WriteOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const seen = receipt ?? commitReceipt(error);
  if (NOT_SENT.test(message) && !sentWrite(seen)) return notAttempted();
  if (reachedCommit && seen && settledSuccess(seen)) return unknownCommit();
  const fromReceipt = reachedCommit && seen ? receiptVerdict(seen, message) : undefined;
  return fromReceipt ?? messageVerdict(message, reachedCommit);
}

function notAttempted(): WriteOutcome {
  return outcome("execution_failed", "not_attempted", false, "same_key");
}

/** Today's message classes, used when no receipt shows how the commit left. */
function messageVerdict(message: string, reachedCommit: boolean): WriteOutcome {
  if (SIGNED_OUT.test(message))
    return outcome(
      "credentials_rejected",
      reachedCommit ? "not_applied" : "not_attempted",
      false,
      "fix_input",
    );
  if (REJECTED.test(message))
    return outcome(
      "input_rejected",
      reachedCommit ? "not_applied" : "not_attempted",
      false,
      "fix_input",
    );
  if (!reachedCommit) return outcome("execution_failed", "not_applied", false, "same_key");
  // A redirect we already classified names page.network.list. That is the next step, not a dropped
  // connection, so it must not fall through to the no-response retry.
  if (message.startsWith("outcome_unknown:"))
    return outcome("outcome_unknown", "may_have_applied", true, "never");
  if (NO_RESPONSE.test(message)) return outcome("no_response", "may_have_applied", true, "never");
  return outcome("outcome_unknown", "may_have_applied", true, "never");
}

function looksLikeReceipt(record: Record<string, unknown>): boolean {
  return (
    Array.isArray(record.requests) ||
    typeof record.lateReply === "string" ||
    typeof record.dialog === "string" ||
    record.processing === true ||
    Array.isArray(record.open)
  );
}

function asReceipt(record: Record<string, unknown>): CommitReceipt {
  const receipt: CommitReceipt = {};
  if (Array.isArray(record.requests))
    receipt.requests = record.requests.filter((item) => item && typeof item === "object");
  if (typeof record.lateReply === "string") receipt.lateReply = record.lateReply;
  if (typeof record.dialog === "string") receipt.dialog = record.dialog;
  if (record.processing === true) receipt.processing = true;
  if (Array.isArray(record.open))
    receipt.open = record.open.filter((item): item is string => typeof item === "string");
  return receipt;
}

function sentWrite(receipt: CommitReceipt | undefined): boolean {
  if (!receipt) return false;
  return mayWrite(receipt).length > 0 || openWrite(receipt);
}

function mayWrite(receipt: CommitReceipt): NonNullable<CommitReceipt["requests"]> {
  return (receipt.requests ?? []).filter(
    (item) => !SAFE_METHOD.has((item.method ?? "").toUpperCase()),
  );
}

function openWrite(receipt: CommitReceipt): boolean {
  return (receipt.open ?? []).some((item) => /request:/i.test(item));
}

/** Unknown while a may-write is unanswered or 5xx; not applied only once every one has answered. */
function receiptVerdict(receipt: CommitReceipt, message: string): WriteOutcome | undefined {
  const writes = mayWrite(receipt);
  if (!writes.length && !openWrite(receipt) && !receipt.processing) return undefined;
  if (commitUnsettled(receipt, writes, message)) return unknownCommit();
  if (writes.some(succeeded)) return undefined;
  if (allRefused(writes)) return refusedCommit();
  return undefined;
}

/** A 2xx write landed. Later dialog text does not undo it. */
function settledSuccess(receipt: CommitReceipt): boolean {
  const writes = mayWrite(receipt);
  return writes.some(succeeded) && !commitUnsettled(receipt, writes, "");
}

function succeeded(item: { status?: number }): boolean {
  const status = item.status ?? 0;
  return status >= 200 && status < 300;
}

function allRefused(writes: NonNullable<CommitReceipt["requests"]>): boolean {
  return writes.length > 0 && writes.every(refusedStatus);
}

function unknownCommit(): WriteOutcome {
  return outcome("outcome_unknown", "may_have_applied", true, "never");
}

function refusedCommit(): WriteOutcome {
  return outcome("input_rejected", "not_applied", false, "fix_input");
}

function commitUnsettled(
  receipt: CommitReceipt,
  writes: NonNullable<CommitReceipt["requests"]>,
  message: string,
): boolean {
  if (openWrite(receipt) || writes.some(unansweredOrServer)) return true;
  return (
    receipt.processing === true || PROCESSING.test(pageText(receipt)) || PROCESSING.test(message)
  );
}

function pageText(receipt: CommitReceipt): string {
  return `${receipt.dialog ?? ""}\n${receipt.lateReply ?? ""}`;
}

function unanswered(item: { status?: number; error?: string }): boolean {
  return item.status === undefined || item.status === 0;
}

function unansweredOrServer(item: { status?: number; error?: string }): boolean {
  return unanswered(item) || (item.status ?? 0) >= 500;
}

function refusedStatus(item: { status?: number }): boolean {
  return REFUSED_STATUS.has(item.status ?? 0);
}

function outcome(
  code: OutcomeCode,
  write_status: WriteStatus,
  possible_commit: boolean,
  retry: RetryClass,
): WriteOutcome {
  return { code, write_status, possible_commit, retry };
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (needle === undefined || needle === null) return true;
  return JSON.stringify(haystack ?? "")
    .toLowerCase()
    .includes(String(needle).toLowerCase());
}

/** Reads the site back after a write and says whether the expected values are there. */
export async function readBack(
  rule: ReadBack,
  inputs: Record<string, unknown>,
  run: (name: string, inputs: Record<string, unknown>) => Promise<unknown>,
  fill: (value: unknown, inputs: Record<string, unknown>) => unknown,
): Promise<{ ok: boolean; missing: string[]; value?: unknown }> {
  try {
    const value = await run(
      rule.ability,
      fill(rule.inputs ?? {}, inputs) as Record<string, unknown>,
    );
    const expect = fill(rule.expect ?? {}, inputs) as Record<string, unknown>;
    const missing = Object.entries(expect)
      .filter(([, wanted]) => !contains(value, wanted))
      .map(([field]) => field);
    return { ok: !missing.length, missing, value };
  } catch (error) {
    return { ok: false, missing: [error instanceof Error ? error.message : String(error)] };
  }
}
