/** Serialize read-only connection initialization, and retry rejected attempts. */
export function connectionSingleFlight(
  connect: () => Promise<void>,
  failed: (message: string) => void,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= connect()
      .catch((error: unknown) =>
        failed(error instanceof Error ? error.message : "Connection failed."),
      )
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
