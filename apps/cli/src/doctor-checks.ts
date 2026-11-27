import {
  SUPPORTED_PROTOCOL_VERSION,
  chromeFlagPurpose,
  chromeRelaunchCommand,
  missingChromeFlags,
  type ProtocolVersion,
} from "@graft/protocol";

export { CHROME_FLAGS } from "@graft/protocol";

const OPEN_GRAFT = "Open Chrome with Graft loaded so the daemon starts.";
const UPDATE =
  "Update Graft so the command, the daemon and the extension are the same build, then reload the extension.";
const RELOAD = "Reload the Graft extension in chrome://extensions.";
const OPEN_EXTENSION =
  "Run `graft setup --again`, then restart Chrome with the Graft extension loaded (in chrome://extensions: turn on Developer mode, click Load unpacked and choose Graft's folder).";
const MODEL_FIX = "Sign in to a model from Graft's Models page.";
const TASK_FIX =
  process.platform === "win32"
    ? "Reinstall the Graft login task (Graft-Core-Login) so the daemon starts at logon."
    : process.platform === "darwin"
      ? "Start the Graft LaunchAgent (com.graft.daemon), or reinstall it so the daemon starts at login."
      : "Start the Graft user service (systemctl --user start graft-daemon), or reinstall it so the daemon starts at login.";
const SUPERVISOR_NAME =
  process.platform === "win32"
    ? "Login task Graft-Core-Login"
    : process.platform === "darwin"
      ? "LaunchAgent com.graft.daemon"
      : "User service graft-daemon";
/** The exact command to relaunch Chrome with, so a normal install can fix the flags check. */
export function chromeFlagsCommand(
  platform: NodeJS.Platform = process.platform,
  flags?: readonly string[],
): string {
  return chromeRelaunchCommand(platform, flags);
}

// None of these flags is needed to use Graft: a normal Chrome launch pairs the extension and runs
// every tool. They hide Chrome's debugger bar and keep background tabs' timers warm, so this check
// is informational rather than a gate, but it names each missing flag and the relaunch command.
const flagsFix = (platform: NodeJS.Platform): string =>
  `Optional: quit Chrome, then relaunch it with: ${chromeFlagsCommand(platform)}`;

export type CheckName =
  | "daemon"
  | "protocol"
  | "extension"
  | "flags"
  | "model"
  | "supervisor"
  | "data"
  // `graft doctor --stealth` reports these three, one line each, with the exact fix.
  | "webrtc"
  | "geo"
  | "tells";

export interface Check {
  name: CheckName;
  status: "ok" | "fail";
  detail: string;
  fix: string;
  /** Printed under an ok line too: optional advice worth acting on. */
  note?: string;
}

/** What the health ping reported. Absent when the daemon never answered. */
export interface HealthView {
  ok: boolean;
  extension: boolean;
  engine: boolean;
  protocolVersion: ProtocolVersion;
  engineProtocol?: ProtocolVersion;
  cdpFailures?: { label: string; count: number }[];
}

export interface DataDir {
  name: string;
  path: string;
  writable: boolean;
  /** Set when the folder is owned by someone else, or reached through an unsafe parent. */
  trustError?: string;
  trustFix?: string;
}

export interface DoctorFacts {
  daemon: HealthView | undefined;
  chromeCommandLines: string[];
  modelSignedIn: boolean;
  loginTask: boolean;
  dirs: DataDir[];
  /** The OS the relaunch command is written for; defaults to this one. */
  platform?: NodeJS.Platform;
  /** Graft uses the calling agent's model through MCP instead of a signed-in model. */
  mcpUsesClientModel?: boolean;
  /** Set when the daemon is down and the supervisor remembered why the last start failed. */
  startError?: string;
}

export function doctorChecks(facts: DoctorFacts): Check[] {
  return [
    daemonCheck(facts.daemon, facts.startError),
    protocolCheck(facts.daemon),
    extensionCheck(facts.daemon),
    flagsCheck(facts.chromeCommandLines, facts.platform ?? process.platform),
    facts.mcpUsesClientModel
      ? line("model", "ok", "Graft uses your agent's model through MCP.", MODEL_FIX)
      : facts.modelSignedIn
        ? line("model", "ok", "A model account is signed in.", MODEL_FIX)
        : line("model", "fail", "No model account is signed in.", MODEL_FIX),
    facts.loginTask
      ? line("supervisor", "ok", `${SUPERVISOR_NAME} is running.`, TASK_FIX)
      : line("supervisor", "fail", `${SUPERVISOR_NAME} is not running.`, TASK_FIX),
    dataCheck(facts.dirs),
  ];
}

export function formatDoctor(checks: Check[], json: boolean): string {
  if (json) {
    const ok = checks.every((check) => check.status === "ok");
    return JSON.stringify({ ok, checks }, null, 2) + "\n";
  }
  return checks.map(formatLine).join("");
}

function daemonCheck(report: HealthView | undefined, startError?: string): Check {
  if (!report) return line("daemon", "fail", daemonDidNotAnswer(startError), OPEN_GRAFT);
  return line(
    "daemon",
    "ok",
    "The daemon answered the health ping." + failureText(report),
    OPEN_GRAFT,
  );
}

function daemonDidNotAnswer(startError: string | undefined): string {
  if (!startError) return "The daemon did not answer.";
  return `The daemon did not answer. Last start failed: ${startError}`;
}

function failureText(report: HealthView): string {
  const rows = report.cdpFailures ?? [];
  if (rows.length === 0) return "";
  return " CDP failures: " + rows.map((row) => `${row.label} ${row.count}`).join(", ");
}

function protocolCheck(report: HealthView | undefined): Check {
  const expected = SUPPORTED_PROTOCOL_VERSION;
  const label = versionText(expected);
  if (!report)
    return line("protocol", "fail", "The daemon did not report a protocol version.", OPEN_GRAFT);
  if (!sameVersion(report.protocolVersion, expected))
    return line(
      "protocol",
      "fail",
      `Daemon protocol ${versionText(report.protocolVersion)} does not match ${label}.`,
      UPDATE,
    );
  if (report.engineProtocol && !sameVersion(report.engineProtocol, expected))
    return line(
      "protocol",
      "fail",
      `Engine protocol ${versionText(report.engineProtocol)} does not match ${label}.`,
      UPDATE,
    );
  return line("protocol", "ok", `Protocol ${label} matches.`, UPDATE);
}

function extensionCheck(report: HealthView | undefined): Check {
  if (report?.engine)
    return line(
      "extension",
      "ok",
      "The extension and the engine answered the health ping.",
      RELOAD,
    );
  if (report?.extension)
    return line(
      "extension",
      "fail",
      "The extension answered, but the engine did not finish the health ping.",
      RELOAD,
    );
  return line("extension", "fail", "No extension is connected to the daemon.", OPEN_EXTENSION);
}

function flagsCheck(lines: string[], platform: NodeJS.Platform): Check {
  const fix = flagsFix(platform);
  const missing = missingChromeFlags(lines);
  if (!missing.length) return line("flags", "ok", "Chrome has all of Graft's flags.", fix);
  // Not a gate: Graft works without them; Chrome just shows its debugger bar and slows background tabs.
  const listed = missing.map((flag) => `${flag} (${chromeFlagPurpose(flag)})`).join("; ");
  return {
    ...line("flags", "ok", `A normal Chrome launch works. Missing optional flags: ${listed}.`, fix),
    note: fix,
  };
}

function dataCheck(dirs: DataDir[]): Check {
  const untrusted = dirs.find((dir) => dir.trustError);
  if (untrusted?.trustError)
    return line("data", "fail", untrusted.trustError, untrusted.trustFix ?? untrusted.trustError);
  const blocked = dirs.filter((dir) => !dir.writable);
  if (!blocked.length)
    return line(
      "data",
      "ok",
      "Data folders are writable.",
      "Make the Graft data folders writable.",
    );
  const listed = blocked.map((dir) => `${dir.name} (${dir.path})`).join("; ");
  const paths = blocked.map((dir) => dir.path).join(", ");
  return line("data", "fail", `${listed} is not writable.`, `Make this folder writable: ${paths}.`);
}

function formatLine(check: Check): string {
  const head = `${check.name.padEnd(12)}${check.status.padEnd(6)}${check.detail}\n`;
  if (check.status === "fail") return `${head}            Fix: ${check.fix}\n`;
  return check.note ? `${head}            ${check.note}\n` : head;
}

function line(name: CheckName, status: "ok" | "fail", detail: string, fix: string): Check {
  return { name, status, detail, fix };
}

function sameVersion(version: ProtocolVersion, expected: ProtocolVersion): boolean {
  return version.major === expected.major && version.minor === expected.minor;
}

function versionText(version: ProtocolVersion): string {
  return `${version.major}.${version.minor}`;
}
