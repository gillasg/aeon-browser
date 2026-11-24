import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { missingChromeFlags } from "@aeon/protocol";

const REFRESH_MS = 30_000;
const EXEC_TIMEOUT_MS = 2_000;

export interface ChromeFlagsProbe {
  /** Cached missing flags; triggers a non-blocking refresh when stale. */
  current(): readonly string[];
  /** Reads running Chrome command lines and updates the cache. */
  refresh(): Promise<readonly string[]>;
}

/**
 * Only reports missing flags when at least one Chrome command line was actually observed: if
 * process inspection fails or no Chrome process is visible (tests, sandboxes), report none so we
 * never show a bogus relaunch notice.
 */
export function missingFromChromeCommandLines(lines: readonly string[]): string[] {
  if (!lines.length) return [];
  return missingChromeFlags(lines);
}

export function createChromeFlagsProbe(
  readLines: () => Promise<string[]> = readChromeCommandLines,
  now: () => number = Date.now,
): ChromeFlagsProbe {
  let cached: readonly string[] = [];
  let refreshedAt = 0;
  let inFlight: Promise<readonly string[]> | undefined;

  const refresh = (): Promise<readonly string[]> => {
    if (inFlight) return inFlight;
    inFlight = readLines()
      .then((lines) => {
        cached = missingFromChromeCommandLines(lines);
        refreshedAt = now();
        return cached;
      })
      .catch(() => cached)
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    current() {
      if (!refreshedAt || now() - refreshedAt >= REFRESH_MS) void refresh();
      return cached;
    },
    refresh,
  };
}

function execLines(file: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
  });
}

function readChromeCommandLines(): Promise<string[]> {
  if (process.platform === "win32")
    return execLines("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
    ]);
  if (process.platform === "darwin")
    return execLines("ps", ["-axo", "command"]).then((lines) =>
      lines.filter((line) => /Google Chrome|Chromium|chrome/i.test(line)),
    );
  return readProcCommandLines();
}

async function readProcCommandLines(): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    const text = await readFile(join("/proc", entry, "cmdline"), "utf8").catch(() => "");
    const command = text.split("\0").filter(Boolean).join(" ");
    if (/chrome/i.test(command) && command.includes("--")) lines.push(command);
  }
  return lines;
}
