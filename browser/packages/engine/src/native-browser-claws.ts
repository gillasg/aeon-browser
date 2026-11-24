// The claws behind page.db, page.downloads, page.archive, page.freeze and page.dryRun: one set
// per tab, made on its first call. A tab no claw was asked about has no state, no listener and
// no CDP domain enabled; a detach or a closed tab drops its set.
import { send } from "./cdp/send.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { dryRunActive } from "./native-browser-dry-run.js";
import type { ClawEvent, ClawPort } from "./native-browser-claw-port.js";
import { StorageDb } from "./native-browser-storage-db.js";
import { DownloadBus, archivePage, type DownloadFilter } from "./native-browser-downloads.js";
import { DryRunShield, SessionFreeze, type DryRunOptions } from "./native-browser-freeze.js";

type Value = Record<string, unknown>;
export interface Claws {
  db: StorageDb;
  downloads: DownloadBus;
  freeze: SessionFreeze;
  dryRun: DryRunShield;
  port: ClawPort;
}

const listeners = new Map<number, Set<ClawEvent>>();
const tabs = new Map<number, Claws>();

function tabPort(tabId: number): ClawPort {
  return {
    send: <T>(method: string, params: Value = {}) =>
      withBrowserDebugger(tabId, (debuggee) =>
        send<T>(debuggee, method, params, { label: "claws" }),
      ),
    on: (listener) => {
      let set = listeners.get(tabId);
      if (!set) listeners.set(tabId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(tabId);
      };
    },
  };
}

/** A tab's claws from any port: the extension's per-tab one, or a test's fake. */
export function makeClaws(port: ClawPort): Claws {
  return {
    port,
    db: new StorageDb(port),
    downloads: new DownloadBus(port),
    freeze: new SessionFreeze(port),
    dryRun: new DryRunShield(port),
  };
}

/** Every CDP domain the claws have on, for tests and the idle check. */
export function clawDomains(claws: Claws): string[] {
  return [...claws.db.enabled(), ...claws.downloads.enabled(), ...claws.dryRun.enabled()];
}

function forTab(tabId: number): Claws {
  let claws = tabs.get(tabId);
  if (!claws) tabs.set(tabId, (claws = makeClaws(tabPort(tabId))));
  return claws;
}

function dropTab(tabId: number): void {
  const claws = tabs.get(tabId);
  if (!claws) return;
  claws.db.detached();
  claws.downloads.detached();
  claws.dryRun.detached();
  tabs.delete(tabId);
  listeners.delete(tabId);
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const set = source.tabId === undefined ? undefined : listeners.get(source.tabId);
    if (!set) return;
    for (const listener of [...set]) listener(method, (params ?? {}) as Value);
  });
  // Snapshots survive a detach (they live here, not in the page); enabled domains do not.
  chrome.debugger.onDetach.addListener((source) => {
    const claws = source.tabId === undefined ? undefined : tabs.get(source.tabId);
    if (!claws) return;
    claws.db.detached();
    claws.downloads.detached();
    claws.dryRun.detached();
  });
  chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId));
});

const str = (value: unknown) => (typeof value === "string" ? value : "");
const opts = (value: unknown): Value =>
  value && typeof value === "object" ? (value as Value) : {};

type Handler = (claws: Claws, value: Value) => unknown;
const HANDLERS: Record<string, Handler> = {
  "db.databases": (c) => c.db.databases(),
  "db.read": (c, v) => c.db.read(str(v.db), str(v.store), opts(v.options)),
  "db.caches": (c) => c.db.cacheNames(),
  "db.cacheEntries": (c, v) => c.db.cacheEntries(str(v.cache), opts(v.options)),
  "db.watch": (c, v) => c.db.watch(opts(v.filter)),
  "db.changes": (c, v) => c.db.changesList(opts(v.options)),
  "db.unwatch": (c) => c.db.unwatch(),
  "db.stop": (c) => c.db.stop().then(() => ({ stopped: true })),
  "downloads.start": (c, v) => c.downloads.start(opts(v.options)),
  "downloads.stop": (c) => c.downloads.stop(),
  "downloads.list": (c, v) => c.downloads.list(opts(v.filter) as DownloadFilter),
  "downloads.waitFor": (c, v) =>
    c.downloads.waitFor(opts(v.filter) as DownloadFilter, Number(v.timeoutMs) || 30000),
  "archive.pdf": (c, v) => archivePage(c.port, "pdf", opts(v.options)),
  "archive.mhtml": (c, v) => archivePage(c.port, "mhtml", opts(v.options)),
  "freeze.snapshot": (c, v) => c.freeze.snapshot(v.label),
  "freeze.restore": (c, v) => c.freeze.restore(v.id),
  "freeze.list": (c) => c.freeze.list(),
  "freeze.drop": (c, v) => c.freeze.drop(v.id),
  "freeze.clear": (c) => c.freeze.clear(),
  "dryRun.start": (c, v) => c.dryRun.start(opts(v.options) as DryRunOptions),
  "dryRun.stop": (c) => c.dryRun.stop(),
  "dryRun.list": (c, v) => c.dryRun.list(opts(v.options)),
};

/** One claw call: {claws: 'db.read', target, db, store, options}. */
export async function clawsCall(tabId: number, value: Value): Promise<unknown> {
  return runClaw(forTab(tabId), value, () => dryRunActive(tabId));
}

/** Runs a claw call against a tab's claws; exported so tests drive it with a fake port. */
export async function runClaw(
  claws: Claws,
  value: Value,
  recordingDryRun: () => boolean = () => false,
): Promise<unknown> {
  const name = String(value.claws);
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`INVALID_INPUT: unknown claw ${name}`);
  if (name === "dryRun.start" && recordingDryRun())
    throw new Error("INVALID_INPUT: this tab already records with {dryRun: true}; stop that first");
  return handler(claws, value);
}
