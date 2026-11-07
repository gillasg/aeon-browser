// A per-tab map that survives the extension's service worker restarting. Chrome may restart it
// mid-run; what the engine keeps in memory about a tab (passwords the agent typed itself, a login
// waiting to be saved) must not vanish with it, or the agent's own page locks against it and the
// login is never saved. chrome.storage.session is memory only, cleared when Chrome closes, and
// not readable by content scripts.

type Area = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};

function area(): Area | undefined {
  return (globalThis as { chrome?: { storage?: { session?: Area } } }).chrome?.storage?.session;
}

export class SessionMap<V> extends Map<number, V> {
  /** Settles once the entries kept before a restart are back. */
  readonly ready: Promise<void>;
  private loading = true;

  constructor(
    private readonly key: string,
    private readonly encode: (value: V) => unknown = (value) => value,
    decode: (value: unknown) => V = (value) => value as V,
  ) {
    super();
    this.ready = (async () => {
      const saved = await area()
        ?.get(key)
        .catch(() => undefined);
      const entries = saved?.[key];
      if (entries && typeof entries === "object")
        for (const [tabId, value] of Object.entries(entries))
          if (!super.has(Number(tabId))) super.set(Number(tabId), decode(value));
      this.loading = false;
    })();
  }

  override set(tabId: number, value: V): this {
    super.set(tabId, value);
    this.save();
    return this;
  }

  override delete(tabId: number): boolean {
    const had = super.delete(tabId);
    if (had) this.save();
    return had;
  }

  private save(): void {
    // The constructor's load runs before the subclass fields exist; nothing to save then.
    if (this.key === undefined) return;
    const write = () =>
      area()
        ?.set({ [this.key]: Object.fromEntries([...this].map(([id, v]) => [id, this.encode(v)])) })
        .catch(() => undefined);
    if (this.loading) void this.ready.then(write);
    else void write();
  }
}
