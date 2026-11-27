import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CHROME_FLAGS, mergeChromeFlags } from "@graft/protocol";

// Opt-in, reversible Chrome launch flags. Linux: a user copy of google-chrome.desktop with the flags
// on every Exec= line. Windows: the user's Chrome shortcuts get the flags appended, old arguments
// saved for undo. macOS: Chrome.app is never touched (codesigning); a small "Graft Chrome.app"
// launcher in ~/Applications starts Chrome with the flags instead.

export const MANAGED_MARK = "# managed-by: graft-chrome-flags";
const LINUX_SOURCES = [
  "/usr/share/applications/google-chrome.desktop",
  "/var/lib/snapd/desktop/applications/google-chrome.desktop",
];

export interface FlagEnv {
  platform: NodeJS.Platform;
  home: string;
  /** Graft's data directory, for the Windows undo record. */
  data: string;
  linuxSources?: string[];
  /** Runs a PowerShell script; returns stdout. */
  powershell?: (script: string, args: string[]) => string;
}

export interface FlagResult {
  done: boolean;
  detail: string;
}

/** Adds the flags an argument string lacks; never duplicates, merges --disable-features lists. */
export function withFlags(argumentsText: string, flags: readonly string[] = CHROME_FLAGS): string {
  return mergeChromeFlags(argumentsText.split(/\s+/).filter(Boolean), flags).join(" ");
}

/** Puts the flags right after the executable on every Exec= line, before %U and friends. */
export function patchDesktop(text: string, flags: readonly string[] = CHROME_FLAGS): string {
  const lines = text.split("\n").map((line) => {
    if (!line.startsWith("Exec=")) return line;
    const [exe = "", ...rest] = line.slice(5).split(" ");
    const options = rest.filter((part) => part.startsWith("--"));
    const others = rest.filter((part) => !part.startsWith("--"));
    const merged = mergeChromeFlags(options, flags);
    const next = "Exec=" + [exe, ...merged, ...others].filter(Boolean).join(" ");
    return merged.join(" ") === options.join(" ") ? line : next;
  });
  const body = lines.join("\n");
  return body.includes(MANAGED_MARK) ? body : `${MANAGED_MARK}\n${body}`;
}

const linuxTarget = (env: FlagEnv) =>
  join(env.home, ".local", "share", "applications", "google-chrome.desktop");
export const macApp = (env: FlagEnv): string => join(env.home, "Applications", "Graft Chrome.app");
const windowsState = (env: FlagEnv) => join(env.data, "chrome-shortcuts.json");

function applyLinux(env: FlagEnv): FlagResult {
  const target = linuxTarget(env);
  const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  const source = (env.linuxSources ?? LINUX_SOURCES).find((path) => existsSync(path));
  const base = existing ?? (source ? readFileSync(source, "utf8") : undefined);
  if (!base) return { done: false, detail: "no google-chrome.desktop found" };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, patchDesktop(base));
  return { done: true, detail: `updated ${target}` };
}

function undoLinux(env: FlagEnv): FlagResult {
  const target = linuxTarget(env);
  if (!existsSync(target) || !readFileSync(target, "utf8").includes(MANAGED_MARK))
    return { done: true, detail: "nothing to undo" };
  rmSync(target);
  return { done: true, detail: `removed ${target}` };
}

export function macLauncherScript(flags: readonly string[] = CHROME_FLAGS): string {
  return `#!/bin/sh\n${MANAGED_MARK}\nexec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ${flags.join(" ")} "$@"\n`;
}

const MAC_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Graft Chrome</string>
<key>CFBundleIdentifier</key><string>com.graft.chrome-launcher</string>
<key>CFBundleExecutable</key><string>graft-chrome</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

function applyMac(env: FlagEnv): FlagResult {
  const app = macApp(env);
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), MAC_PLIST);
  const exe = join(contents, "MacOS", "graft-chrome");
  writeFileSync(exe, macLauncherScript());
  chmodSync(exe, 0o755);
  return { done: true, detail: `created ${app}; open Chrome with "Graft Chrome" from Spotlight` };
}

function undoMac(env: FlagEnv): FlagResult {
  const app = macApp(env);
  if (!existsSync(app)) return { done: true, detail: "nothing to undo" };
  rmSync(app, { recursive: true, force: true });
  return { done: true, detail: `removed ${app}` };
}

// Lists Desktop and Start Menu Chrome shortcuts as JSON {path, args}; with $Set, writes args back.
const WINDOWS_SCRIPT = `param([string]$Set = "")
$shell = New-Object -ComObject WScript.Shell
if ($Set) { foreach ($row in (ConvertFrom-Json $Set)) { $l = $shell.CreateShortcut($row.path); $l.Arguments = $row.args; $l.Save() }; exit 0 }
$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))
$out = @()
foreach ($d in $dirs) { if ($d -and (Test-Path $d)) { Get-ChildItem -Path $d -Filter 'Google Chrome.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $out += @{ path = $_.FullName; args = $shell.CreateShortcut($_.FullName).Arguments } } } }
ConvertTo-Json -Compress -InputObject @($out)`;

export interface Shortcut {
  path: string;
  args: string;
}

/** The new shortcut args plus the undo record, keeping the first-seen original args. */
export function planShortcuts(
  current: Shortcut[],
  saved: Shortcut[],
): { next: Shortcut[]; record: Shortcut[] } {
  const record = [...saved];
  for (const item of current)
    if (!record.some((row) => row.path === item.path)) record.push({ ...item });
  return { next: current.map((item) => ({ path: item.path, args: withFlags(item.args) })), record };
}

const runPowershell = (script: string, args: string[]) =>
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, ...args],
    { encoding: "utf8" },
  );

function readSaved(env: FlagEnv): Shortcut[] {
  try {
    return JSON.parse(readFileSync(windowsState(env), "utf8")) as Shortcut[];
  } catch {
    return [];
  }
}

function applyWindows(env: FlagEnv): FlagResult {
  const ps = env.powershell ?? runPowershell;
  const listed = JSON.parse(ps(WINDOWS_SCRIPT, []) || "[]") as Shortcut[];
  if (!listed.length) return { done: false, detail: "no Google Chrome shortcut found" };
  const { next, record } = planShortcuts(listed, readSaved(env));
  mkdirSync(env.data, { recursive: true });
  writeFileSync(windowsState(env), JSON.stringify(record, null, 2));
  ps(WINDOWS_SCRIPT, ["-Set", JSON.stringify(next)]);
  return { done: true, detail: `updated ${next.length} Chrome shortcut(s)` };
}

function undoWindows(env: FlagEnv): FlagResult {
  const saved = readSaved(env);
  if (!saved.length) return { done: true, detail: "nothing to undo" };
  (env.powershell ?? runPowershell)(WINDOWS_SCRIPT, ["-Set", JSON.stringify(saved)]);
  rmSync(windowsState(env), { force: true });
  return { done: true, detail: `restored ${saved.length} Chrome shortcut(s)` };
}

export function applyChromeFlags(env: FlagEnv): FlagResult {
  if (env.platform === "darwin") return applyMac(env);
  if (env.platform === "win32") return applyWindows(env);
  return applyLinux(env);
}

export function undoChromeFlags(env: FlagEnv): FlagResult {
  if (env.platform === "darwin") return undoMac(env);
  if (env.platform === "win32") return undoWindows(env);
  return undoLinux(env);
}

export function defaultFlagEnv(data: string): FlagEnv {
  return { platform: process.platform, home: homedir(), data };
}
