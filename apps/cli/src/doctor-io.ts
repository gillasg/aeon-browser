import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreHealthResultSchema } from "@aeon/protocol";
import { aeonDataDirectory, ensurePrivateDir, UntrustedDirError } from "@aeon/location";
import type { DaemonHost } from "./host.js";
import type { DataDir, HealthView } from "./doctor-checks.js";
import type { StealthFacts } from "./doctor-stealth-checks.js";
import { gatherStealthFacts } from "./doctor-stealth-io.js";
import { readStartFailure } from "./start-failure.js";

export interface DoctorIo {
  daemon(): Promise<HealthView | undefined>;
  chromeCommandLines(): Promise<string[]>;
  modelSignedIn(): Promise<boolean>;
  loginTask(): Promise<boolean>;
  dataDirs(): Promise<DataDir[]>;
  /** Optional so existing fakes stay valid. Absent means no remembered start cause. */
  startFailure?(): Promise<string | undefined>;
  /** Only used by `aeon doctor --stealth`; opens and closes one hidden tab. */
  stealthFacts?(): Promise<StealthFacts>;
}

export function liveDoctorIo(host: DaemonHost): DoctorIo {
  return {
    daemon: () => readDaemon(host),
    chromeCommandLines: readChromeCommandLines,
    modelSignedIn: () => modelSignedIn(modelAuthPath()),
    loginTask: loginTaskPresent,
    dataDirs: readDataDirs,
    startFailure: readStartFailure,
    stealthFacts: () => gatherStealthFacts(host),
  };
}

export function dataDirPaths(
  env: NodeJS.ProcessEnv = process.env,
): { name: string; path: string }[] {
  const home = homedir();
  const local =
    process.platform === "win32"
      ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : env.XDG_DATA_HOME || join(home, ".local", "share");
  return [
    { name: "Aeon", path: aeonDataDirectory({ env }) },
    { name: "browserkit", path: env.BROWSERKIT_HOME ?? join(local, "browserkit") },
    { name: "site-to-api", path: env.SITE_TO_API_HOME ?? join(home, ".site-to-api") },
  ];
}

export function modelAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  const dir = configured ? resolve(expandHome(configured)) : join(homedir(), ".pi", "agent");
  return join(dir, "auth.json");
}

export async function modelSignedIn(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.values(parsed as Record<string, unknown>).some(isCredential);
  } catch {
    return false;
  }
}

export async function directoryWritable(path: string): Promise<boolean> {
  const probe = join(path, `.aeon-doctor-${process.pid}-${Date.now()}`);
  try {
    await mkdir(path, { recursive: true });
    await writeFile(probe, "ok", { flag: "wx" });
    await unlink(probe);
    return true;
  } catch {
    await unlink(probe).catch(() => undefined);
    return false;
  }
}

async function readDaemon(host: DaemonHost): Promise<HealthView | undefined> {
  try {
    return viewOf(await (await host.connect()).health());
  } catch {
    return undefined;
  }
}

function viewOf(message: unknown): HealthView | undefined {
  const parsed = CoreHealthResultSchema.safeParse(message);
  if (!parsed.success) return undefined;
  const view: HealthView = {
    ok: parsed.data.ok,
    extension: parsed.data.extension,
    engine: parsed.data.engine,
    protocolVersion: parsed.data.protocolVersion,
  };
  if (parsed.data.engineProtocol) view.engineProtocol = parsed.data.engineProtocol;
  if (parsed.data.cdpFailures?.length) view.cdpFailures = parsed.data.cdpFailures;
  return view;
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

/** Linux: the main Chrome process carries every flag in /proc/<pid>/cmdline. */
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

export interface ServiceProbeOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  exec?: (file: string, args: string[]) => Promise<boolean>;
}

/** Where the login service file lives; presence alone says nothing about it running. */
export function serviceFilePath(options: ServiceProbeOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", "com.aeon.daemon.plist");
  if (platform === "linux")
    return join(
      env.XDG_CONFIG_HOME || join(home, ".config"),
      "systemd",
      "user",
      "aeon-daemon.service",
    );
  return undefined;
}

/** True only when the service manager reports the login service running. */
export async function supervisorServiceActive(options: ServiceProbeOptions = {}): Promise<boolean> {
  const file = serviceFilePath(options);
  if (!file || !existsSync(file)) return false;
  const exec = options.exec ?? commandAnswered;
  if ((options.platform ?? process.platform) === "darwin") {
    const uid = options.uid ?? process.getuid?.() ?? 501;
    return exec("launchctl", ["print", `gui/${uid}/com.aeon.daemon`]);
  }
  return exec("systemctl", ["--user", "is-active", "--quiet", "aeon-daemon.service"]);
}

function commandAnswered(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (error) => resolve(!error));
  });
}

function loginTaskPresent(): Promise<boolean> {
  if (process.platform !== "win32") return supervisorServiceActive();
  return new Promise((resolve) => {
    execFile(
      "schtasks.exe",
      ["/Query", "/TN", "Aeon-Core-Login"],
      { timeout: 8000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

async function readDataDirs(): Promise<DataDir[]> {
  return Promise.all(dataDirPaths().map((dir) => inspectDataDir(dir)));
}

async function inspectDataDir(dir: { name: string; path: string }): Promise<DataDir> {
  const fix = trustFix(dir.name);
  try {
    await ensurePrivateDir(dir.path, { fix });
  } catch (error) {
    return {
      ...dir,
      writable: false,
      trustError: error instanceof Error ? error.message : String(error),
      trustFix: error instanceof UntrustedDirError ? error.fix : fix,
    };
  }
  return { ...dir, writable: await directoryWritable(dir.path) };
}

function trustFix(name: string): string {
  if (name === "browserkit") return "Set BROWSERKIT_HOME to a directory you own with mode 700.";
  if (name === "site-to-api") return "Set SITE_TO_API_HOME to a directory you own with mode 700.";
  return "Set AEON_DATA_DIR to a directory you own with mode 700.";
}

function execLines(file: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve([]);
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
      },
    );
  });
}

function isCredential(value: unknown): boolean {
  const type = (value as { type?: unknown } | null)?.type;
  return type === "api_key" || type === "oauth";
}

function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}
