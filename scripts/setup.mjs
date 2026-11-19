// Sets Aeon up from a fresh clone in one command (install.ps1 and install.sh run it): builds Aeon,
// installs the native host and the background service for this OS, puts the `aeon` command and
// skill in place, adds Aeon's MCP server to the coding agents on this machine, then installs the
// extension and waits for it.
//
//   node scripts/setup.mjs              everything
//   node scripts/setup.mjs --no-agents  leave coding agents' configs alone
//   node scripts/setup.mjs --no-wait    do not wait for the extension
//   node scripts/setup.mjs --again      repeat only the pieces that are missing or broken
//   node scripts/setup.mjs --extension  guided extension step only (used by `aeon setup`)
//   node scripts/setup.mjs --yes        non-interactive: short wait, no first-run tab (CI)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  copyToStableFolder,
  nativeDist,
  stableFolder,
} from "../apps/native-host/scripts/extension-folder.mjs";
import { pnpmCommand, runCommand } from "./setup-process.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const again = args.has("--again");
const extensionOnly = args.has("--extension");
const yes = args.has("--yes");
const extension = stableFolder();
const cli = join(root, "apps", "cli", "dist", "cli.js");
const say = (line) => process.stdout.write(line + "\n");
const windows = process.platform === "win32";
const mac = process.platform === "darwin";
const linux = process.platform === "linux";
const summonShortcut = mac ? "Cmd+Shift+Space" : "Ctrl+Shift+Space";
const pasteKey = mac ? "Cmd+V" : "Ctrl+V";

if (!windows && !mac && !linux) {
  say(`Aeon does not support ${process.platform} yet.`);
  process.exit(1);
}

const run = (command, commandArgs, options = {}) =>
  runCommand(command, commandArgs, { cwd: root, stdio: "inherit", ...options });

const built = () =>
  existsSync(cli) &&
  existsSync(join(root, "apps", "daemon", "dist", "main.js")) &&
  existsSync(join(nativeDist, "manifest.json"));

if (!extensionOnly) {
  if (!again || !built()) {
    say("1/4 Building Aeon…");
    run(pnpmCommand(), ["install", "--ignore-scripts"]);
    run(pnpmCommand(), ["build"]);
  } else say("1/4 Build is already in place.");

  say("2/4 Installing the native host and the background service…");
  if (windows) installWindowsHost();
  else run(process.execPath, [join("apps", "native-host", "scripts", "install.mjs")]);

  say("3/4 Installing the aeon command and skill…");
  if (!again || !commandInstalled()) run(process.execPath, [cli, "install"]);
  if (!again) await connectAgents();
  else say("Coding agents are already configured.");
}

say(extensionOnly ? "Loading the Aeon extension" : "4/4 The extension");
if (!existsSync(cli)) {
  say("Aeon is not built in this folder. Run the one-line installer first, then `aeon setup`.");
  process.exit(1);
}
if ((await extensionConnected()) && !args.has("--no-wait")) {
  say(connectedMessage());
  process.exit(0);
}
copyToStableFolder(nativeDist, extension);
if (!existsSync(join(extension, "manifest.json"))) throw new Error("The extension did not build.");
await presentExtension(extension);
say(loadInstructions());
if (args.has("--no-wait")) process.exit(0);
say("Waiting for Aeon to connect (Ctrl+C to stop)…");
const waitMs = yes ? 90_000 : 10 * 60_000;
for (let waited = 0; waited < waitMs; waited += 3000) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (await extensionConnected()) {
    say("Connected. You're done.");
    if (!yes) await openFirstRun();
    process.exit(0);
  }
}
say(
  `Chrome did not connect within ${Math.round(waitMs / 60_000)} minutes. Load ${extension} in chrome://extensions, then run \`aeon setup --again\`. Aeon needs no Chrome flags: a normal Chrome launch works.`,
);
process.exit(1);

function installWindowsHost() {
  const installed = (() => {
    try {
      execFileSync(
        "reg.exe",
        ["query", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.aeon.native_host"],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  })();
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join("scripts", "setup-core.ps1"),
    ...(installed ? ["-Update"] : []),
  ]);
}

/** The engine's setup pieces, built a moment ago. */
async function connectAgents() {
  if (args.has("--no-agents")) return;
  const bridge = join(root, "browser", "apps", "bridge", "dist");
  const { connectAgents: connect } = await import(
    pathToFileURL(join(bridge, "connect-agents.js")).href
  );
  const results = await connect({ name: "aeon", command: process.execPath, args: [cli, "mcp"] });
  for (const result of results)
    say(`   ${result.done ? "Connected" : "Could not connect"} ${result.agent} (${result.detail})`);
}

/** Exactly three short steps, then the installer confirms the connection itself. */
function loadInstructions() {
  return [
    "Last step, in the chrome://extensions tab that just opened:",
    "  1. Turn on Developer mode (top right).",
    "  2. Click Load unpacked.",
    `  3. Paste the folder (${pasteKey}) and choose it.`,
    "The folder is on your clipboard: " + extension,
    "A normal Chrome launch is fine; Aeon needs no special flags.",
  ].join("\n");
}

/** `aeon install` picks npm's folder only when it is already on PATH, else ~/.local/bin. */
function commandInstalled() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = windows
    ? [join(process.env.APPDATA ?? "", "npm", "aeon.cmd"), join(home, ".local", "bin", "aeon")]
    : [join(home, ".local", "bin", "aeon")];
  return candidates.some(existsSync);
}

function connectedMessage() {
  return `Aeon is connected. Open its Chat from the toolbar, or press ${summonShortcut} on any page.`;
}

/** Show the new user Aeon's Chat as soon as the extension pairs, not chrome://extensions. */
async function openFirstRun() {
  const bridge = join(root, "browser", "apps", "bridge", "dist");
  const { openFirstRunPage } = await import(pathToFileURL(join(bridge, "setup-extension.js")).href);
  openFirstRunPage();
}

/** The extension answers through the daemon only once it is loaded and connected. */
async function extensionConnected() {
  let output;
  try {
    output = execFileSync(process.execPath, [cli, "doctor", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
  } catch (error) {
    // Doctor exits 1 when any check fails (there is no model in CI). Its JSON is still there.
    output = error?.stdout;
    if (!output) return false;
  }
  try {
    const text = String(output);
    const report = JSON.parse(text.slice(text.indexOf("{")));
    return Boolean(
      (report.checks ?? []).find((check) => check.name === "extension" && check.status === "ok"),
    );
  } catch {
    return false;
  }
}

async function presentExtension(folder) {
  const bridge = join(root, "browser", "apps", "bridge", "dist");
  const { presentExtension: present } = await import(
    pathToFileURL(join(bridge, "setup-extension.js")).href
  );
  present(folder);
}
