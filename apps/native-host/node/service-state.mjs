import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The login service may exist as a file yet not be running: stopped by the user, failed past its
// start limit, or never started after a boot. A file is not a supervisor, so ask the manager.

export const DAEMON_UNIT = "graft-daemon.service";
export const DAEMON_LABEL = "com.graft.daemon";

export function serviceFile(options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", DAEMON_LABEL + ".plist");
  if (platform === "linux")
    return join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", DAEMON_UNIT);
  return undefined;
}

/** "absent" when no service file, "active" when its manager runs it, "inactive" otherwise. */
export function serviceState(options = {}) {
  const platform = options.platform ?? process.platform;
  const file = serviceFile(options);
  if (!file || !existsSync(file)) return "absent";
  const exec = options.exec ?? defaultExec;
  if (platform === "darwin")
    return answered(exec, "launchctl", ["print", darwinTarget(options)]) ? "active" : "inactive";
  if (platform === "linux")
    return answered(exec, "systemctl", ["--user", "is-active", "--quiet", DAEMON_UNIT])
      ? "active"
      : "inactive";
  return "absent";
}

/**
 * Asks the service manager to start an installed service and says whether the request was
 * accepted. The host keeps retrying the bootstrap socket either way.
 */
export function startService(options = {}) {
  const platform = options.platform ?? process.platform;
  const file = serviceFile(options);
  if (!file || !existsSync(file)) return false;
  const exec = options.exec ?? defaultExec;
  if (platform === "darwin") return startLaunchAgent(exec, options, file);
  if (platform === "linux") return startSystemdUser(exec, options);
  return false;
}

function startLaunchAgent(exec, options, file) {
  if (answered(exec, "launchctl", ["kickstart", "-k", darwinTarget(options)])) return true;
  if (answered(exec, "launchctl", ["bootstrap", darwinUser(options), file])) return true;
  options.log?.write("Could not start the Graft LaunchAgent.");
  return false;
}

function startSystemdUser(exec, options) {
  // A unit past StartLimitBurst stays refused until the failure counter is cleared.
  answered(exec, "systemctl", ["--user", "reset-failed", DAEMON_UNIT]);
  if (answered(exec, "systemctl", ["--user", "start", DAEMON_UNIT])) return true;
  options.log?.write("Could not start the Graft user service.");
  return false;
}

function defaultExec(file, args) {
  execFileSync(file, args, { stdio: "ignore", windowsHide: true });
}

function answered(exec, file, args) {
  try {
    exec(file, args);
    return true;
  } catch {
    return false;
  }
}

function darwinUser(options) {
  const uid = options.uid ?? process.getuid?.() ?? 501;
  return `gui/${uid}`;
}

function darwinTarget(options) {
  return `${darwinUser(options)}/${DAEMON_LABEL}`;
}
