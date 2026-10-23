import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

const MAX_OUTPUT_BYTES = 24_000;
export const MAX_ARGUMENTS = 64;
export const MAX_ARGUMENT_LENGTH = 1_000;
export const RUN_TIMEOUT_MS = 30_000;
export const HELP_TIMEOUT_MS = 10_000;

export interface CliProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

export function resolveRegisteredExecutable(
  executable: string,
  workingDirectory: string | null,
): string {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\"))
    return resolve(workingDirectory ?? process.cwd(), executable);
  return executable;
}

export function readArguments(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS)
    throw new Error(`args must contain no more than ${MAX_ARGUMENTS} strings.`);
  return value.map((argument) => {
    if (typeof argument !== "string" || argument.length > MAX_ARGUMENT_LENGTH)
      throw new Error(
        `Each CLI argument must be a string of at most ${MAX_ARGUMENT_LENGTH} characters.`,
      );
    return argument;
  });
}

export async function runRegisteredCli(input: {
  executable: string;
  args: string[];
  workingDirectory: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<CliProcessResult> {
  const child = spawn(input.executable, input.args, {
    cwd: input.workingDirectory,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createOutputCollector();
  const stderr = createOutputCollector();
  child.stdout?.on("data", stdout.append);
  child.stderr?.on("data", stderr.append);
  let timedOut = false;
  let cancelled = false;
  let terminating = false;
  const terminate = (): void => {
    if (terminating) return;
    terminating = true;
    void terminateProcessTree(child);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);
  const abort = (): void => {
    cancelled = true;
    terminate();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  return await new Promise<CliProcessResult>((resolveResult) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      resolveResult({
        exitCode,
        signal,
        timedOut,
        cancelled,
        stdout: stdout.read(),
        stderr: stderr.read(),
      });
    };
    child.once("error", () => finish(null, null));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

function createOutputCollector(): { append(chunk: Buffer | string): void; read(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - size;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      chunks.push(bytes.subarray(0, remaining));
      size += Math.min(bytes.byteLength, remaining);
      if (bytes.byteLength > remaining) truncated = true;
    },
    read() {
      return Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[output truncated]" : "");
    },
  };
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const taskkill = systemRoot ? resolve(systemRoot, "System32", "taskkill.exe") : "taskkill.exe";
    await new Promise<void>((resolveResult) => {
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      const fallback = setTimeout(() => {
        child.kill();
        resolveResult();
      }, 1_500);
      killer.once("error", () => {
        clearTimeout(fallback);
        child.kill();
        resolveResult();
      });
      killer.once("close", () => {
        clearTimeout(fallback);
        child.kill();
        resolveResult();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const killTimer = setTimeout(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 750);
  child.once("close", () => clearTimeout(killTimer));
}
