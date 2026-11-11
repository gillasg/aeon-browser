// One bounded send for chrome.debugger. A call that outlives its limit rejects, and that tab stays
// single-flight until the late call settles, so a retry fails at once instead of waiting out another
// limit. Reads are not retried: a retry would hit that rule and fail immediately. Slow machines
// raise engineConfig.cdpLimitFactor. The happy path starts sendCommand in this turn and waits only
// on that call.

import { beginLazyDomain, setDomainFailureNote } from "./domains.js";
import { engineConfig } from "../engine-config.js";
import { noteLateInput, noteLateInputLanded } from "../native-browser-receipts.js";

export type CallClass = "read" | "input" | "eval" | "nav" | "attach" | "emulate";

export interface SendOptions {
  ms?: number;
  cls?: CallClass;
  label?: string;
}

export interface CallRecord {
  method: string;
  label?: string;
  tabId?: number;
  ms: number;
  ok: boolean;
  err?: string;
  late?: boolean;
}

const CLASS_MS: Record<Exclude<CallClass, "eval">, number> = {
  read: 5_000,
  input: 5_000,
  emulate: 3_000,
  attach: 10_000,
  nav: 30_000,
};
const NAV = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"]);
const EVAL = new Set(["Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.awaitPromise"]);
const RING = 200;

interface Meta {
  method: string;
  label?: string;
  cls: CallClass;
  ms: number;
}
interface Flight {
  tabId?: number;
  method: string;
  label?: string;
  started: number;
}
interface Gate {
  done: boolean;
}

const stuck = new Map<number, Promise<unknown>>();
const flights = new Set<Flight>();
const records: CallRecord[] = [];
const failures = new Map<string, number>();

/** Swallowed and thrown CDP failures, per label, for `aeon doctor`. */
export function cdpFailures(): { label: string; count: number }[] {
  return [...failures]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

export function callClass(method: string): CallClass {
  if (method.startsWith("Input.")) return "input";
  if (method.startsWith("Emulation.")) return "emulate";
  if (method === "Target.attachToTarget" || method === "attach") return "attach";
  if (NAV.has(method)) return "nav";
  if (EVAL.has(method)) return "eval";
  return "read";
}

/** Wall-clock limit for a method, after cdpLimitFactor. Eval is the caller's ms plus 1 s. */
export function callLimitMs(method: string, callerMs?: number): number {
  return scale(baseMs(callClass(method), callerMs));
}

export function send<T = unknown>(
  d: chrome.debugger.DebuggerSession,
  method: string,
  params?: object,
  o?: SendOptions,
): Promise<T> {
  return dispatch(d, method, params, o, false);
}

/**
 * A wake sent while this tab is already single-flight. Page.setWebLifecycleState has to go out
 * after a hung Page.enable; it does not replace the call the tab is waiting on.
 */
export function sendWake<T = unknown>(
  d: chrome.debugger.DebuggerSession,
  method: string,
  params?: object,
  o?: SendOptions,
): Promise<T> {
  return dispatch(d, method, params, o, true);
}

/** Time-limit for a promise that is not a CDP method (debugger.attach). Same single-flight map. */
export function bounded<T>(
  tabId: number,
  work: Promise<T>,
  ms: number,
  label = "attach",
): Promise<T> {
  const meta: Meta = { method: "Debugger.attach", label, cls: "attach", ms: scale(ms) };
  if (stuck.has(tabId)) return rejectStuck(tabId, meta.method, label);
  return watch(tabId, work, meta, { done: false });
}

export function inflight(): { tabId?: number; method: string; label?: string; ageMs: number }[] {
  const now = Date.now();
  return [...flights].map((flight) => ({
    ...(flight.tabId !== undefined ? { tabId: flight.tabId } : {}),
    method: flight.method,
    ...(flight.label ? { label: flight.label } : {}),
    ageMs: now - flight.started,
  }));
}

export function recent(tabId?: number): CallRecord[] {
  const rows = tabId === undefined ? records : records.filter((row) => row.tabId === tabId);
  return rows.map((row) => ({ ...row }));
}

function dispatch<T>(
  d: chrome.debugger.DebuggerSession,
  method: string,
  params: object | undefined,
  o: SendOptions | undefined,
  wake: boolean,
): Promise<T> {
  const meta = callMeta(method, o);
  if (!meta) return Promise.reject(missingMs(method, o?.label));
  const held = heldTab(wake, d.tabId);
  if (held !== undefined) return rejectStuck(held, method, o?.label);
  const gate: Gate = { done: false };
  // The flight and its deadline start in this turn. A lazy Domain.enable shares that deadline.
  // Once the call has timed out, the command itself is not sent when enable finally returns.
  return watch(d.tabId, perform(d, method, params, meta, o?.ms, gate), meta, gate);
}

function perform<T>(
  d: chrome.debugger.DebuggerSession,
  method: string,
  params: object | undefined,
  meta: Meta,
  ms: number | undefined,
  gate: Gate,
): Promise<T> {
  const enable = beginLazyDomain(d, method);
  if (enable === undefined) return issued(d, method, params, meta, ms);
  return enable.then(() => {
    if (gate.done) return undefined as T;
    return issued(d, method, params, meta, ms);
  });
}

function callMeta(method: string, o: SendOptions | undefined): Meta | undefined {
  const cls = o?.cls ?? callClass(method);
  if (needsMs(cls, o)) return undefined;
  const label = o?.label;
  return { method, ...(label ? { label } : {}), cls, ms: scale(baseMs(cls, o?.ms)) };
}

function needsMs(cls: CallClass, o: SendOptions | undefined): boolean {
  return cls === "eval" && !validMs(o?.ms);
}

function heldTab(wake: boolean, tabId: number | undefined): number | undefined {
  if (wake || tabId === undefined || !stuck.has(tabId)) return undefined;
  return tabId;
}

function issued<T>(
  d: chrome.debugger.DebuggerSession,
  method: string,
  params: object | undefined,
  meta: Meta,
  ms: number | undefined,
): Promise<T> {
  return chrome.debugger.sendCommand(d, method, commandBody(params, meta.cls, ms)) as Promise<T>;
}

function commandBody(
  params: object | undefined,
  cls: CallClass,
  ms: number | undefined,
): { [key: string]: unknown } | undefined {
  const body = params as { [key: string]: unknown } | undefined;
  if (cls !== "eval") return body;
  return { ...body, timeout: ms };
}

function watch<T>(tabId: number | undefined, work: Promise<T>, meta: Meta, gate: Gate): Promise<T> {
  const started = Date.now();
  const flight: Flight = {
    method: meta.method,
    started,
    ...(tabId !== undefined ? { tabId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  };
  flights.add(flight);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (ok: boolean, err?: string, ms = Date.now() - started): CallRecord => {
    gate.done = true;
    flights.delete(flight);
    if (timer !== undefined) clearTimeout(timer);
    return remember(entry(tabId, meta, ms, ok, err));
  };
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => onTimeout(tabId, work, meta, gate, stop, reject), meta.ms);
    work.then(
      (value) => {
        if (gate.done) return;
        stop(true);
        resolve(value);
      },
      (error: unknown) => {
        if (gate.done) return;
        stop(false, messageOf(error));
        reject(error instanceof Error ? error : new Error(messageOf(error)));
      },
    );
  });
}

function onTimeout<T>(
  tabId: number | undefined,
  work: Promise<T>,
  meta: Meta,
  gate: Gate,
  stop: (ok: boolean, err?: string, ms?: number) => CallRecord,
  reject: (error: Error) => void,
): void {
  if (gate.done) return;
  const error = timeoutError(meta, tabId);
  const record = stop(false, error.message, meta.ms);
  if (tabId !== undefined) armStuck(tabId, work, record, meta);
  if (meta.cls === "input" && tabId !== undefined) noteLateInput(tabId, callName(meta));
  reject(error);
}

function armStuck(tabId: number, work: Promise<unknown>, record: CallRecord, meta: Meta): void {
  const mark = (): void => {
    record.late = true;
    if (meta.cls === "input") noteLateInputLanded(tabId);
  };
  if (stuck.has(tabId)) {
    void work.then(mark, mark);
    return;
  }
  const late = work.then(
    () => undefined,
    () => undefined,
  );
  stuck.set(tabId, late);
  void late.then(() => {
    mark();
    if (stuck.get(tabId) === late) stuck.delete(tabId);
  });
}

/**
 * A timed-out call keeps the tab single-flight until Chrome answers it. A hand-off has to publish
 * its waiting flag anyway: the next send is attempted, and a late answer still clears only its own
 * entry.
 */
export function releaseStuck(tabId: number): void {
  stuck.delete(tabId);
}

function rejectStuck(tabId: number, method: string, label?: string): Promise<never> {
  const error = new Error("TAB_UNRESPONSIVE: the tab has not answered an earlier call yet");
  remember({
    method,
    ...(label ? { label } : {}),
    tabId,
    ms: 0,
    ok: false,
    err: error.message,
  });
  return Promise.reject(error);
}

function timeoutError(meta: Meta, tabId: number | undefined): Error {
  const code = meta.cls === "eval" || meta.cls === "nav" ? "TIMEOUT" : "TAB_UNRESPONSIVE";
  const seconds = (meta.ms / 1000).toFixed(1);
  let text = `${code}: ${callName(meta)} did not answer in ${seconds} s on tab ${tabId ?? "?"}`;
  if (meta.cls !== "input") return new Error(text);
  text += ` {"mayHaveLateEffects":true}`;
  return Object.assign(new Error(text), { mayHaveLateEffects: true as const });
}

function missingMs(method: string, label?: string): Error {
  const name = label ? `${method} (${label})` : method;
  return new Error(`TIMEOUT: ${name} needs ms`);
}

function callName(meta: Meta): string {
  return meta.label ? `${meta.method} (${meta.label})` : meta.method;
}

function baseMs(cls: CallClass, callerMs: number | undefined): number {
  if (cls === "eval") return (callerMs ?? 0) + 1_000;
  if (validMs(callerMs)) return callerMs;
  return CLASS_MS[cls];
}

function scale(ms: number): number {
  const factor = engineConfig.cdpLimitFactor;
  const applied = typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  return Math.max(1, Math.round(ms * applied));
}

function validMs(ms: number | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entry(
  tabId: number | undefined,
  meta: Meta,
  ms: number,
  ok: boolean,
  err?: string,
): CallRecord {
  return {
    method: meta.method,
    ...(meta.label ? { label: meta.label } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
    ms,
    ok,
    ...(err ? { err: err.slice(0, 300) } : {}),
  };
}

function remember(record: CallRecord): CallRecord {
  records.push(record);
  if (records.length > RING) records.shift();
  if (!record.ok) noteFailure(record.label ?? record.method);
  return record;
}

function noteFailure(label: string): void {
  failures.set(label, (failures.get(label) ?? 0) + 1);
}

setDomainFailureNote(noteFailure);
