import { SUPPORTED_PROTOCOL_VERSION, type ProtocolVersion } from "@aeon/protocol";

export const CHROME_FLAGS = [
  "--silent-debugger-extension-api",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
] as const;

const OPEN_AEON = "Open Chrome with Aeon loaded so the daemon starts.";
const UPDATE =
  "Update Aeon so the command, the daemon and the extension are the same build, then reload the extension.";
const RELOAD = "Reload the Aeon extension in chrome://extensions.";
const OPEN_EXTENSION = "Open Chrome with the Aeon extension loaded.";
const MODEL_FIX = "Sign in to a model from Aeon's Models page.";
const TASK_FIX = "Reinstall the Aeon login task (Aeon-Core-Login) so the daemon starts at logon.";
const FLAGS_FIX = `Restart Chrome with these flags: ${CHROME_FLAGS.join(" ")}.`;

export type CheckName =
  "daemon" | "protocol" | "extension" | "flags" | "model" | "supervisor" | "data";

export interface Check {
  name: CheckName;
  status: "ok" | "fail";
  detail: string;
  fix: string;
}

/** What the health ping reported. Absent when the daemon never answered. */
export interface HealthView {
  ok: boolean;
  extension: boolean;
  engine: boolean;
  protocolVersion: ProtocolVersion;
  engineProtocol?: ProtocolVersion;
}

export interface DataDir {
  name: string;
  path: string;
  writable: boolean;
}

export interface DoctorFacts {
  daemon: HealthView | undefined;
  chromeCommandLines: string[];
  modelSignedIn: boolean;
  loginTask: boolean;
  dirs: DataDir[];
}

export function doctorChecks(facts: DoctorFacts): Check[] {
  return [
    daemonCheck(facts.daemon),
    protocolCheck(facts.daemon),
    extensionCheck(facts.daemon),
    flagsCheck(facts.chromeCommandLines),
    facts.modelSignedIn
      ? line("model", "ok", "A model account is signed in.", MODEL_FIX)
      : line("model", "fail", "No model account is signed in.", MODEL_FIX),
    facts.loginTask
      ? line("supervisor", "ok", "Login task Aeon-Core-Login is registered.", TASK_FIX)
      : line("supervisor", "fail", "Login task Aeon-Core-Login is not registered.", TASK_FIX),
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

function daemonCheck(report: HealthView | undefined): Check {
  if (!report) return line("daemon", "fail", "The daemon did not answer.", OPEN_AEON);
  return line("daemon", "ok", "The daemon answered the health ping.", OPEN_AEON);
}

function protocolCheck(report: HealthView | undefined): Check {
  const expected = SUPPORTED_PROTOCOL_VERSION;
  const label = versionText(expected);
  if (!report)
    return line("protocol", "fail", "The daemon did not report a protocol version.", OPEN_AEON);
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

function flagsCheck(lines: string[]): Check {
  const missing = fewestMissing(lines);
  if (!missing.length) return line("flags", "ok", "Chrome has Aeon's flags.", FLAGS_FIX);
  const detail = lines.length
    ? `Chrome is missing ${missing.join(", ")}.`
    : "Chrome is not running with Aeon's flags.";
  return line("flags", "fail", detail, FLAGS_FIX);
}

/** Flags still absent from the Chrome process that already has the most of them. */
function fewestMissing(lines: string[]): string[] {
  return lines.reduce(
    (fewest, command) => {
      const missing = CHROME_FLAGS.filter((flag) => !command.includes(flag));
      return missing.length < fewest.length ? [...missing] : fewest;
    },
    [...CHROME_FLAGS],
  );
}

function dataCheck(dirs: DataDir[]): Check {
  const blocked = dirs.filter((dir) => !dir.writable);
  if (!blocked.length)
    return line("data", "ok", "Data folders are writable.", "Make the Aeon data folders writable.");
  const listed = blocked.map((dir) => `${dir.name} (${dir.path})`).join("; ");
  const paths = blocked.map((dir) => dir.path).join(", ");
  return line("data", "fail", `${listed} is not writable.`, `Make this folder writable: ${paths}.`);
}

function formatLine(check: Check): string {
  const head = `${check.name.padEnd(12)}${check.status.padEnd(6)}${check.detail}\n`;
  return check.status === "fail" ? `${head}            Fix: ${check.fix}\n` : head;
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
