import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { CapabilityDefinition, CliCapability } from "@pippin/domain";

export async function verifyCliCapability(
  capability: CliCapability,
  signal?: AbortSignal,
): Promise<{ state: "verified" | "failed"; summary: string }> {
  try {
    const summary = await verifyCli(capability, signal);
    return { state: "verified", summary };
  } catch (error) {
    if (signal?.aborted) throw new Error("CAPABILITY_RECHECK_CANCELLED", { cause: error });
    const message = error instanceof Error ? error.message : "Verification failed.";
    return { state: "failed", summary: safeFailure(message) };
  }
}

async function verifyCli(
  capability: Extract<CapabilityDefinition, { kind: "cli" }>,
  signal?: AbortSignal,
): Promise<string> {
  const cwd = capability.launcher.workingDirectory
    ? resolve(capability.launcher.workingDirectory)
    : process.cwd();
  return await new Promise<string>((resolveResult, reject) => {
    const child = spawn(capability.launcher.executable, ["--version"], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalProbeEnvironment(),
    });
    let settled = false;
    const finish = function (error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      if (error) reject(error);
      else resolveResult("The executable returned exit code 0 for the fixed --version probe.");
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("CLI_VERSION_PROBE_TIMEOUT"));
    }, 5_000);
    const abortListener = (): void => {
      child.kill();
      finish(new Error("CLI_VERSION_PROBE_CANCELLED"));
    };
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", () => finish(new Error("CLI_VERSION_PROBE_FAILED")));
    child.once("close", (code) =>
      code === 0 ? finish() : finish(new Error("CLI_VERSION_PROBE_FAILED")),
    );
    if (signal?.aborted) abortListener?.();
    else if (abortListener) signal?.addEventListener("abort", abortListener, { once: true });
  });
}

function minimalProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function safeFailure(message: string): string {
  if (message.includes("TIMEOUT")) return "The declared safe verification probe timed out.";
  return "The declared safe verification probe failed.";
}
