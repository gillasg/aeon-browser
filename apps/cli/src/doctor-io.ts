import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CoreHealthResultSchema } from "@aeon/protocol";
import type { DaemonHost } from "./host.js";
import type { DataDir, HealthView } from "./doctor-checks.js";

export interface DoctorIo {
  daemon(): Promise<HealthView | undefined>;
  chromeCommandLines(): Promise<string[]>;
  modelSignedIn(): Promise<boolean>;
  loginTask(): Promise<boolean>;
  dataDirs(): Promise<DataDir[]>;
}

export function liveDoctorIo(host: DaemonHost): DoctorIo {
  return {
    daemon: () => readDaemon(host),
    chromeCommandLines: readChromeCommandLines,
    modelSignedIn: () => modelSignedIn(modelAuthPath()),
    loginTask: loginTaskPresent,
    dataDirs: readDataDirs,
  };
}

export function dataDirPaths(
  env: NodeJS.ProcessEnv = process.env,
): { name: string; path: string }[] {
  const home = homedir();
  const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    { name: "Aeon", path: env.AEON_DATA_DIR ?? join(local, "Aeon", "data") },
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
  return view;
}

function readChromeCommandLines(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return execLines("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
  ]);
}

function loginTaskPresent(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
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
  const dirs = dataDirPaths();
  const writable = await Promise.all(dirs.map((dir) => directoryWritable(dir.path)));
  return dirs.map((dir, index) => ({ ...dir, writable: writable[index] === true }));
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
