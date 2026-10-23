/** Local phase timings only: no prompts, paths, credentials, or external telemetry. */
export function startupTiming(phase: string, startedAt: number): void {
  process.stderr.write(
    JSON.stringify({ kind: "core.startup-timing", phase, durationMs: Date.now() - startedAt }) +
      "\n",
  );
}

export async function timeStartupStep<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    startupTiming(phase, startedAt);
  }
}
