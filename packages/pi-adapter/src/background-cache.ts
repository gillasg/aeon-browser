/** Serve the last successful value immediately while a single refresh runs. */
export class BackgroundCache<T> {
  private value: T | undefined;
  private pending: Promise<T> | undefined;
  private refreshedAt = 0;
  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
  ) {}
  read(): Promise<T> {
    if (!this.pending && (this.value === undefined || Date.now() - this.refreshedAt >= this.ttlMs))
      this.refresh();
    if (this.value !== undefined) return Promise.resolve(this.value);
    return this.pending ?? Promise.reject(new Error("Cache initialization did not start."));
  }
  /** The next read loads fresh data (the current value is still served meanwhile). */
  invalidate(): void {
    this.refreshedAt = 0;
  }
  private refresh(): void {
    const pending = this.load()
      .then((value) => {
        this.value = value;
        this.refreshedAt = Date.now();
        return value;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    void pending.catch(() => undefined);
  }
}
