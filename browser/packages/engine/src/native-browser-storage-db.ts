// page.db: the tab origin's own app databases. IndexedDB stores, Cache Storage entries, and a
// push watch on localStorage/sessionStorage changes. Nothing is enabled until asked: IndexedDB is
// enabled on the first IndexedDB read, DOMStorage only while a watch runs, and stop() or a detach
// turns both off. Every value returned is scrubbed of tokens, JWTs, passwords and keys.
import {
  Ring,
  clampLimit,
  evaluate,
  scrubPair,
  scrubUrl,
  scrubValue,
  type ClawPort,
} from "./native-browser-claw-port.js";

type Params = Record<string, unknown>;
interface RemoteObject {
  type?: string;
  value?: unknown;
  objectId?: string;
  description?: string;
}
interface IdbKey {
  type: string;
  number?: number;
  string?: string;
  date?: number;
  array?: IdbKey[];
}
export interface StorageChange {
  at: number;
  kind: "added" | "updated" | "removed" | "cleared";
  storage: "local" | "session";
  origin: string;
  key?: string;
  value?: string;
  oldValue?: string;
}
export interface WatchFilter {
  storage?: "local" | "session";
  key?: string;
  max?: number;
}

const DOM_EVENTS: Record<string, StorageChange["kind"]> = {
  "DOMStorage.domStorageItemAdded": "added",
  "DOMStorage.domStorageItemUpdated": "updated",
  "DOMStorage.domStorageItemRemoved": "removed",
  "DOMStorage.domStorageItemsCleared": "cleared",
};

function toKey(value: unknown): IdbKey {
  if (typeof value === "number") return { type: "number", number: value };
  if (value instanceof Date) return { type: "date", date: value.getTime() };
  if (Array.isArray(value)) return { type: "array", array: value.map(toKey) };
  return { type: "string", string: String(value) };
}

/** {lower?, upper?, lowerOpen?, upperOpen?} in plain values, as CDP's IndexedDB.KeyRange. */
export function keyRange(range: unknown): Params | undefined {
  if (!range || typeof range !== "object") return undefined;
  const r = range as Params;
  if (r.lower === undefined && r.upper === undefined) return undefined;
  return {
    ...(r.lower !== undefined ? { lower: toKey(r.lower) } : {}),
    ...(r.upper !== undefined ? { upper: toKey(r.upper) } : {}),
    lowerOpen: r.lowerOpen === true,
    upperOpen: r.upperOpen === true,
  };
}

export class StorageDb {
  private idbOn = false;
  private watching: WatchFilter | undefined;
  private off: (() => void) | undefined;
  private readonly changes: Ring<StorageChange>;
  constructor(
    private readonly port: ClawPort,
    max = 200,
  ) {
    this.changes = new Ring(max);
  }

  /** The CDP domains this claw has turned on (empty while idle). */
  enabled(): string[] {
    return [...(this.idbOn ? ["IndexedDB"] : []), ...(this.watching ? ["DOMStorage"] : [])];
  }

  private origin(): Promise<string> {
    return evaluate<string>(this.port, "location.origin");
  }

  private async idb(): Promise<string> {
    if (!this.idbOn) {
      await this.port.send("IndexedDB.enable");
      this.idbOn = true;
    }
    return this.origin();
  }

  async databases(): Promise<unknown[]> {
    const securityOrigin = await this.idb();
    const names = await this.port.send<{ databaseNames?: string[] }>(
      "IndexedDB.requestDatabaseNames",
      { securityOrigin },
    );
    const out: unknown[] = [];
    for (const databaseName of names.databaseNames ?? []) {
      const db = await this.port.send<{ databaseWithObjectStores?: Params }>(
        "IndexedDB.requestDatabase",
        { securityOrigin, databaseName },
      );
      const info = db.databaseWithObjectStores ?? {};
      const stores = (info.objectStores as Params[] | undefined) ?? [];
      out.push({
        name: databaseName,
        version: info.version,
        stores: stores.map((s) => ({
          name: s.name,
          keyPath: s.keyPath,
          autoIncrement: s.autoIncrement,
          indexes: ((s.indexes as Params[] | undefined) ?? []).map((i) => i.name),
        })),
      });
    }
    return scrubValue(out);
  }

  async read(dbName: string, storeName: string, options: Params = {}): Promise<unknown> {
    if (!dbName || !storeName) throw new Error("INVALID_INPUT: page.db.indexedDb.read(db, store)");
    const securityOrigin = await this.idb();
    const range = keyRange(options.keyRange);
    const reply = await this.port.send<{ objectStoreDataEntries?: Params[]; hasMore?: boolean }>(
      "IndexedDB.requestData",
      {
        securityOrigin,
        databaseName: dbName,
        objectStoreName: storeName,
        indexName: typeof options.index === "string" ? options.index : "",
        skipCount: clampLimit(options.skip, 0, 1e6),
        pageSize: clampLimit(options.limit, 50, 500),
        ...(range ? { keyRange: range } : {}),
      },
    );
    const rows = [];
    for (const entry of reply.objectStoreDataEntries ?? [])
      rows.push({
        key: await this.plain(entry.primaryKey as RemoteObject),
        value: await this.plain(entry.value as RemoteObject),
      });
    return { db: dbName, store: storeName, rows: scrubValue(rows), hasMore: !!reply.hasMore };
  }

  /** A RemoteObject as plain JSON, releasing the handle. */
  private async plain(object: RemoteObject | undefined): Promise<unknown> {
    if (!object) return undefined;
    if (!object.objectId) return object.value ?? object.description;
    try {
      const reply = await this.port.send<{ result?: { value?: unknown } }>(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration: "function(){return this}",
          returnByValue: true,
        },
      );
      return reply.result?.value;
    } catch {
      return object.description;
    } finally {
      void this.port.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  }

  async cacheNames(): Promise<unknown[]> {
    const securityOrigin = await this.origin();
    const reply = await this.port.send<{ caches?: Params[] }>("CacheStorage.requestCacheNames", {
      securityOrigin,
    });
    return (reply.caches ?? []).map((c) => ({ name: c.cacheName, id: c.cacheId }));
  }

  async cacheEntries(cacheName: string, options: Params = {}): Promise<unknown> {
    const securityOrigin = await this.origin();
    const names = await this.port.send<{ caches?: Params[] }>("CacheStorage.requestCacheNames", {
      securityOrigin,
    });
    const cache = (names.caches ?? []).find((c) => c.cacheName === cacheName);
    if (!cache) throw new Error(`TARGET_NOT_FOUND: no cache named ${cacheName}`);
    const reply = await this.port.send<{ cacheDataEntries?: Params[]; returnCount?: number }>(
      "CacheStorage.requestEntries",
      {
        cacheId: cache.cacheId,
        skipCount: clampLimit(options.skip, 0, 1e6),
        pageSize: clampLimit(options.limit, 50, 500),
        ...(typeof options.path === "string" ? { pathFilter: options.path } : {}),
      },
    );
    const entries = (reply.cacheDataEntries ?? []).map((e) => ({
      url: scrubUrl(String(e.requestURL ?? "")),
      method: e.requestMethod,
      status: e.responseStatus,
      type: e.responseType,
      time: e.responseTime,
      headers: Object.fromEntries(
        ((e.responseHeaders as { name: string; value: string }[] | undefined) ?? []).map((h) => [
          h.name,
          scrubPair(h.name, h.value),
        ]),
      ),
    }));
    return { cache: cacheName, entries, total: reply.returnCount ?? entries.length };
  }

  /** Starts pushing storage changes into the ring; a second watch replaces the filter. */
  async watch(filter: WatchFilter = {}): Promise<unknown> {
    if (!this.watching) {
      this.off = this.port.on((method, params) => this.onEvent(method, params));
      await this.port.send("DOMStorage.enable");
    }
    this.watching = { ...filter };
    return { watching: true, ...this.watching };
  }

  private onEvent(method: string, params: Params): void {
    const kind = DOM_EVENTS[method];
    const filter = this.watching;
    if (!kind || !filter) return;
    const id = (params.storageId ?? {}) as { securityOrigin?: string; isLocalStorage?: boolean };
    const storage = id.isLocalStorage === false ? "session" : "local";
    const key = typeof params.key === "string" ? params.key : undefined;
    if (filter.storage && filter.storage !== storage) return;
    if (filter.key && key !== undefined && !key.includes(filter.key)) return;
    const value = (name: string) =>
      typeof params[name] === "string" ? scrubPair(key ?? "", params[name] as string) : undefined;
    const change: StorageChange = {
      at: Date.now(),
      kind,
      storage,
      origin: String(id.securityOrigin ?? ""),
      ...(key !== undefined ? { key } : {}),
    };
    const next = value("newValue");
    if (next !== undefined) change.value = next;
    const old = value("oldValue");
    if (old !== undefined) change.oldValue = old;
    this.changes.push(change);
  }

  /** What the watch has heard, oldest first; {clear: true} empties it after reading. */
  changesList(options: Params = {}): unknown {
    const list = this.changes.list();
    const dropped = this.changes.dropped;
    if (options.clear === true) this.changes.clear();
    return { changes: list, dropped, watching: !!this.watching };
  }

  async unwatch(): Promise<unknown> {
    if (!this.watching) return { watching: false };
    this.watching = undefined;
    this.off?.();
    this.off = undefined;
    await this.port.send("DOMStorage.disable").catch(() => undefined);
    return { watching: false };
  }

  /** Turns off every domain this claw enabled. */
  async stop(): Promise<void> {
    await this.unwatch();
    if (this.idbOn) {
      this.idbOn = false;
      await this.port.send("IndexedDB.disable").catch(() => undefined);
    }
  }

  /** The debugger went away: its domains are already off, so only forget them. */
  detached(): void {
    this.idbOn = false;
    this.watching = undefined;
    this.off?.();
    this.off = undefined;
  }
}
