/**
 * A worker that never answers must not hold a page's connection attempt forever: the page
 * could then neither retry nor report an error, and stayed on "Connecting…" until reload.
 */
export function withConnectionTimeout<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new Error("CONNECTION_TIMEOUT")),
      milliseconds,
    );
    pending.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
