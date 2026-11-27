import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// The bash tool stays on for every run. What it may touch is narrowed instead: secrets leave its
// environment, and where the OS offers a kernel sandbox (Seatbelt on macOS, bubblewrap on Linux)
// the user's browser profiles, keychains, credential stores and Graft's own token files are walled
// off below the shell, so no quoting, symlink or interpreter trick reaches them. Elsewhere the
// path guard in browser-profile-guard.ts is the line of defence.

export type SandboxBackend = "seatbelt" | "bwrap" | "guard-only";

export interface SandboxStatus {
  backend: SandboxBackend;
  active: boolean;
  reason?: string;
}

export interface SensitivePathOptions {
  env?: NodeJS.ProcessEnv;
}

/** Folders and files no machine tool may read or change, for this home and OS. */
export function sensitivePaths(
  homeDir: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  options: SensitivePathOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  const at = (...parts: string[]) => path.join(homeDir, ...parts);
  const list = [
    at(".ssh"),
    at(".gnupg"),
    at(".aws"),
    at(".kube"),
    at(".docker", "config.json"),
    at(".config", "gh"),
    at(".config", "gcloud"),
    at(".azure"),
    at(".netrc"),
    at(".npmrc"),
    at(".pypirc"),
    at(".git-credentials"),
    at(".password-store"),
  ];
  if (platform === "darwin") {
    const support = (...parts: string[]) => at("Library", "Application Support", ...parts);
    list.push(
      at("Library", "Keychains"),
      at("Library", "Cookies"),
      at("Library", "Safari"),
      at("Library", "Containers", "com.apple.Safari"),
      support("Google", "Chrome"),
      support("Chromium"),
      support("Microsoft Edge"),
      support("BraveSoftware"),
      support("Firefox", "Profiles"),
    );
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? at("AppData", "Local");
    const roaming = env.APPDATA ?? at("AppData", "Roaming");
    list.push(
      path.join(local, "Google", "Chrome", "User Data"),
      path.join(local, "Chromium", "User Data"),
      path.join(local, "Microsoft", "Edge", "User Data"),
      path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
      path.join(roaming, "Mozilla", "Firefox", "Profiles"),
      path.join(roaming, "Microsoft", "Credentials"),
      path.join(local, "Microsoft", "Credentials"),
      path.join(roaming, "Microsoft", "Protect"),
    );
  } else {
    const config = env.XDG_CONFIG_HOME || at(".config");
    list.push(
      path.join(config, "google-chrome"),
      path.join(config, "google-chrome-beta"),
      path.join(config, "chromium"),
      path.join(config, "microsoft-edge"),
      path.join(config, "BraveSoftware"),
      at(".mozilla", "firefox"),
      at(".local", "share", "keyrings"),
    );
  }
  list.push(...graftSecretFiles(homeDir, platform, env));
  return [...new Set(list)];
}

/** Graft's token-bearing files only: the data folder also holds chat workspaces, left open. */
function graftSecretFiles(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const path = platform === "win32" ? win32 : posix;
  const expand = (value: string) => path.resolve(value.replace(/^~(?=$|[\\/])/, home));
  const appRoot =
    platform === "win32"
      ? path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Graft")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Graft")
        : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "graft");
  const data = env.GRAFT_DATA_DIR ? expand(env.GRAFT_DATA_DIR) : path.join(appRoot, "data");
  const agent = env.PI_CODING_AGENT_DIR
    ? expand(env.PI_CODING_AGENT_DIR)
    : path.join(home, ".pi", "agent");
  return [
    path.join(data, "core-connection.json"),
    path.join(data, "cdp.json"),
    path.join(data, "password-manager.json"),
    path.join(data, "pi-agent-config", "auth.json"),
    path.join(agent, "auth.json"),
  ];
}

const SECRET_NAME = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS?|_ACCESS_KEY|_PRIVATE_KEY)$/i;
const SECRET_EXACT = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GRAFT_DAEMON_TOKEN",
]);
const KEEP = new Set(["PATH", "HOME", "USER", "TMPDIR", "LANG", "TERM", "SHELL"]);

/** The shell's environment without credentials; proxy and basic session variables are kept. */
export function scrubSandboxEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const secret = !KEEP.has(upper) && (SECRET_EXACT.has(upper) || SECRET_NAME.test(name));
    if (!secret) clean[name] = value;
  }
  return clean;
}

/** Seatbelt string literal: backslash and quote escaped, control characters dropped. */
function seatbeltString(value: string): string {
  // eslint-disable-next-line no-control-regex
  return `"${value.replace(/[\u0000-\u001f]/g, "").replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** A Seatbelt profile that allows everything except the given paths. */
export function seatbeltProfile(paths: readonly string[]): string {
  const rules = paths.map((p) => `  (subpath ${seatbeltString(p)})`).join("\n");
  return `(version 1)\n(allow default)\n(deny file-read* file-write*\n${rules})\n`;
}

/** bubblewrap arguments: the host as-is, each existing sensitive folder masked by empty tmpfs. */
export function bwrapArgs(
  paths: readonly string[],
  cwd: string,
  exists: (path: string) => "dir" | "file" | undefined = pathKind,
): string[] {
  const args = ["--bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const path of paths) {
    const kind = exists(path);
    if (kind === "dir") args.push("--tmpfs", path);
    else if (kind === "file") args.push("--ro-bind", "/dev/null", path);
  }
  args.push("--chdir", cwd);
  return args;
}

function pathKind(path: string): "dir" | "file" | undefined {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SEATBELT = "/usr/bin/sandbox-exec";
let detected: SandboxStatus | undefined;

function probe(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 3000 });
  if (result.error) return result.error.message;
  return result.status === 0 ? undefined : `self-test exited ${result.status}`;
}

/** Which kernel sandbox this host offers; probed once per process. */
export function detectSandboxBackend(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; refresh?: boolean } = {},
): SandboxStatus {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.GRAFT_OS_SANDBOX === "0")
    return { backend: "guard-only", active: false, reason: "GRAFT_OS_SANDBOX=0" };
  if (detected && !options.refresh) return detected;
  if (platform === "darwin") {
    const failed = existsSync(SEATBELT)
      ? probe(SEATBELT, ["-p", "(version 1)(allow default)", "/usr/bin/true"])
      : "sandbox-exec not found";
    detected = failed
      ? { backend: "guard-only", active: false, reason: failed }
      : { backend: "seatbelt", active: true };
  } else if (platform === "linux") {
    const failed = probe("bwrap", [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--",
      "true",
    ]);
    detected = failed
      ? { backend: "guard-only", active: false, reason: `bwrap unavailable: ${failed}` }
      : { backend: "bwrap", active: true };
  } else {
    detected = { backend: "guard-only", active: false, reason: `no kernel sandbox on ${platform}` };
  }
  return detected;
}

/** The sandbox the bash tool runs under, for diagnostics. */
export function sandboxStatus(): SandboxStatus {
  return detectSandboxBackend();
}

export interface WrapOptions {
  cwd: string;
  status?: SandboxStatus;
  paths?: readonly string[];
  /** The shell started inside the sandbox; `bash` from PATH by default. */
  shell?: string;
}

/** The command, run by the outer shell, re-run inside the kernel sandbox when one is active. */
export function wrapSandboxedCommand(command: string, options: WrapOptions): string {
  const status = options.status ?? detectSandboxBackend();
  if (!status.active) return command;
  const paths = options.paths ?? sensitivePaths();
  const inner = [options.shell ?? "bash", "-c", command];
  const argv =
    status.backend === "seatbelt"
      ? [SEATBELT, "-p", seatbeltProfile(paths), ...inner]
      : ["bwrap", ...bwrapArgs(paths, options.cwd), "--", ...inner];
  return `exec ${argv.map(shellQuote).join(" ")}`;
}
