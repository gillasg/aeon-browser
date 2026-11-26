#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appRoot, dataDirectory, hostPaths } from "../node/paths.mjs";
import { stopSupervisor } from "../node/host.mjs";
import { launchAgent, systemdUnit } from "./service-files.mjs";

// Installs the Mac/Linux half of Aeon: the Node native host wrapper, its Chrome manifests, the
// host configuration and the login service that keeps one daemon supervisor running.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hostEntry = join(repoRoot, "apps", "native-host", "node", "native-host.mjs");
const daemonEntry = join(repoRoot, "apps", "daemon", "dist", "main.js");
const extensionManifest = join(
  repoRoot,
  "apps",
  "chrome-extension",
  "native-dist",
  "manifest.json",
);
const EXTENSION_ID = "npcdopokfkpfmepknhoecppgdgmkmihh";
const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA89DgbMVu50oH2AAiN0vILGKRKc2ePGR9r1W92yDIiVq9n1rxtqxQZSLsxPKuymvi3wB9hpo0h9vJ3++teaw8fqBllliSeELEAUmPNhauLcvlKe1nhkbgRf2wXilCUVI+zumNinkqw5h85rew1FI894ev8M9wWzSHm90eL9WILlWTrjhdaNTpMs2w9sF8GrsKj+sX1anF9/iUfZ9hbracUa47Z2b4KiviZp5SlF6o+0SwFHbeOVM0Aq2nHMFujmfaOcW7TkxDdPXBns2uRY1CTmRIyi3B1pONLQd8ERteRbOlj2BM9AYIrnGyJScaKAu7OUht0gI4C/NlEhdQruxTfQIDAQAB";

const say = (line) => process.stdout.write(line + "\n");

if (process.platform === "win32") {
  say("Windows uses scripts/setup-core.ps1 and the C# host.");
  process.exit(1);
}

const root = appRoot();
const data = dataDirectory();
const node = realpathSync(process.execPath);
const launcher = join(root, "aeon-native-host");

checkBuild();
await stopExisting();
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(data, { recursive: true, mode: 0o700 });
writeLauncher();
writeJson(join(root, "host-config.json"), {
  extensionId: EXTENSION_ID,
  nodeExecutable: node,
  daemonEntrypoint: daemonEntry,
  dataDirectory: data,
});
writeManifests();
installService();
say(`Registered com.aeon.native_host for chrome-extension://${EXTENSION_ID}/`);
say(`Browser extension: ${dirname(extensionManifest)}`);
say(`Daemon data: ${data}`);
say(`Service: ${servicePath()}`);

function checkBuild() {
  if (!existsSync(hostEntry) || !existsSync(daemonEntry))
    throw new Error("Build Aeon first with pnpm build.");
  if (existsSync(extensionManifest)) {
    const manifest = JSON.parse(readFileSync(extensionManifest, "utf8"));
    if (manifest.key !== EXTENSION_KEY)
      throw new Error("The native extension key does not match the installed host origin.");
  }
}

async function stopExisting() {
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "stop", "aeon-daemon.service"], {
        stdio: "ignore",
      });
    } catch {
      // The unit is not installed or not running; a manual supervisor may be.
    }
  }
  if (!existsSync(launcher)) return;
  const code = await stopSupervisor();
  if (code !== 0) return;
  for (let waited = 0; waited < 10_000; waited += 100) {
    if (!existsSync(hostPaths().socket)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
}

function writeLauncher() {
  const script = `#!/bin/sh\nexec "${node.replaceAll('"', '\\"')}" "${hostEntry.replaceAll('"', '\\"')}" "$@"\n`;
  writeFileSync(launcher, script, { mode: 0o755 });
  chmodSync(launcher, 0o755);
}

function writeManifests() {
  const manifest = {
    name: "com.aeon.native_host",
    description: "Aeon native messaging host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  for (const folder of nativeMessagingFolders()) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeJson(join(folder, "com.aeon.native_host.json"), manifest);
  }
}

function nativeMessagingFolders() {
  const home = homedir();
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return ["Google/Chrome", "Google/Chrome for Testing", "Chromium"].map((product) =>
      join(support, product, "NativeMessagingHosts"),
    );
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return ["google-chrome", "google-chrome-for-testing", "chromium"].map((product) =>
    join(config, product, "NativeMessagingHosts"),
  );
}

function installService() {
  if (process.platform === "darwin") installLaunchAgent();
  else installSystemdUserService();
}

function installSystemdUserService() {
  const path = servicePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, systemdUnit({ node, hostEntry }));
  run("systemctl", ["--user", "daemon-reload"]);
  try {
    run("systemctl", ["--user", "reset-failed", "aeon-daemon.service"]);
  } catch {
    // No failed unit to reset.
  }
  run("systemctl", ["--user", "enable", "--now", "aeon-daemon.service"]);
  run("systemctl", ["--user", "restart", "aeon-daemon.service"]);
  enableLinger();
}

function enableLinger() {
  const user = userInfo().username;
  try {
    const state = execFileSync("loginctl", ["show-user", user, "-p", "Linger", "--value"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (state === "yes") return;
  } catch {
    // No logind here; the service still starts with the user's session.
  }
  try {
    execFileSync("sudo", ["-n", "loginctl", "enable-linger", user], { stdio: "ignore" });
    say(`Enabled lingering for ${user}, so Aeon runs without a login session.`);
  } catch {
    say(`Run this once so Aeon runs before you log in: sudo loginctl enable-linger ${user}`);
  }
}

function installLaunchAgent() {
  const path = servicePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, launchAgent({ node, hostEntry, root }));
  const uid = process.getuid();
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/com.aeon.daemon`], { stdio: "ignore" });
  } catch {
    // Not loaded yet.
  }
  try {
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, path], { stdio: "inherit" });
  } catch {
    run("launchctl", ["load", "-w", path]);
  }
}

function servicePath() {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "LaunchAgents", "com.aeon.daemon.plist");
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "systemd", "user", "aeon-daemon.service");
}

function writeJson(path, value) {
  const temporary = path + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}
