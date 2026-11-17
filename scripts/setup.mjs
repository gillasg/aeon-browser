// Sets Aeon up from a fresh clone in one command (install.ps1 and install.sh run it): builds Aeon,
// installs the native host and the background service for this OS, puts the `aeon` command and
// skill in place, adds Aeon's MCP server to the coding agents on this machine, then installs the
// extension and waits for it.
//
//   node scripts/setup.mjs              everything
//   node scripts/setup.mjs --no-agents  leave coding agents' configs alone
//   node scripts/setup.mjs --no-wait    do not wait for the extension
//   node scripts/setup.mjs --again      repeat only the pieces that are missing or broken
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

if (!again || !built()) {
  say("1/4 Building Aeon…");
  run(pnpmCommand(), ["install", "--ignore-scripts"]);
  run(pnpmCommand(), ["build"]);
} else say("1/4 Build is already in place.");

say("2/4 Installing the native host and the background service…");
if (windows) installWindowsHost();
else run(process.execPath, [join("apps", "native-host", "scripts", "install.mjs")]);

say("3/4 Installing the aeon command and skill…");
const commandPath = windows
  ? join(process.env.APPDATA ?? "", "npm", "aeon.cmd")
  : join(process.env.HOME ?? "", ".local", "bin", "aeon");
if (!again || !existsSync(commandPath)) run(process.execPath, [cli, "install"]);
if (!again) await connectAgents();
else say("Coding agents are already configured.");

say("4/4 The extension");
if (await extensionConnected()) {
  say(`Aeon is connected. Open it from the toolbar, or press ${summonShortcut} on any page.`);
  process.exit(0);
}
copyToStableFolder(nativeDist, extension);
if (!existsSync(join(extension, "manifest.json"))) throw new Error("The extension did not build.");
presentExtension(extension);
say(loadInstructions());
if (args.has("--no-wait")) process.exit(0);
say("Waiting for Aeon to connect (Ctrl+C to stop)…");
for (let waited = 0; waited < 10 * 60_000; waited += 3000) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (await extensionConnected()) {
    say("Connected. You're done.");
    process.exit(0);
  }
}
say(
  `Chrome did not connect within 10 minutes. Load ${extension} in chrome://extensions, then run \`aeon setup --again\`.`,
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
  ].join("\n");
}

/** The extension answers through the daemon only once it is loaded and connected. */
async function extensionConnected() {
  try {
    execFileSync(process.execPath, [cli, "settings"], { stdio: "ignore", timeout: 15_000 });
    return true;
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
