// Sets Aeon up from a fresh clone in one command (Windows): fetches and builds browserkit next
// to this folder, builds Aeon, installs the native host and its login task, puts the `aeon`
// command and skill in place, adds Aeon's MCP server to the coding agents on this machine, then
// opens chrome://extensions with the extension folder on the clipboard and waits for it.
//
//   node scripts/setup.mjs              everything
//   node scripts/setup.mjs --no-agents  leave coding agents' configs alone
//   node scripts/setup.mjs --no-wait    do not wait for the extension
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const extension = join(root, "apps", "chrome-extension", "native-dist");
const cli = join(root, "apps", "cli", "dist", "cli.js");
const say = (line) => process.stdout.write(line + "\n");

if (process.platform !== "win32") {
  say("Aeon's background service runs on Windows for now. On macOS and Linux, use browserkit:");
  say("  npx browserkit setup");
  process.exit(1);
}

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { cwd: root, stdio: "inherit", shell: true, ...options });

say("1/5 Fetching and building browserkit…");
run(process.execPath, [join("scripts", "link-repos.mjs")]);
say("2/5 Building Aeon…");
run("pnpm", ["install", "--ignore-scripts"]);
run("pnpm", ["build"]);

say("3/5 Installing the native host and the background service…");
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

say("4/5 Installing the aeon command and skill…");
run(process.execPath, [cli, "install"]);

// browserkit's own setup pieces, built a moment ago by link-repos.
const bridge = join(dirname(root), "browserkit", "apps", "bridge", "dist");
const { connectAgents } = await import(pathToFileURL(join(bridge, "connect-agents.js")).href);
const { presentExtension } = await import(pathToFileURL(join(bridge, "setup-extension.js")).href);
if (!args.has("--no-agents")) {
  const results = await connectAgents({
    name: "aeon",
    command: process.execPath,
    args: [cli, "mcp"],
  });
  for (const result of results)
    say(`   ${result.done ? "Connected" : "Could not connect"} ${result.agent} (${result.detail})`);
}

say("5/5 The extension");
if (await extensionConnected()) {
  say("Aeon is connected. Open it from the toolbar, or press Ctrl+Shift+Space on any page.");
  process.exit(0);
}
if (!existsSync(join(extension, "manifest.json"))) throw new Error("The extension did not build.");
presentExtension(extension);
say("In the chrome://extensions tab that just opened, turn on Developer mode, click Load");
say("unpacked and choose this folder (its path is on your clipboard):");
say("  " + extension);
if (args.has("--no-wait")) process.exit(0);
say("Waiting for Aeon to connect (Ctrl+C to stop)…");
for (let waited = 0; waited < 10 * 60_000; waited += 3000) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (await extensionConnected()) {
    say("Connected. Open Aeon from the toolbar, or press Ctrl+Shift+Space on any page.");
    process.exit(0);
  }
}
say("Still not connected; reload the extension in chrome://extensions and run this again.");
process.exit(1);

/** The extension answers through the daemon only once it is loaded and connected. */
async function extensionConnected() {
  try {
    execFileSync(process.execPath, [cli, "settings"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
