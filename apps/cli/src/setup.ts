import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activeProvider } from "@browserkit/credentials";
import { listSites, registryRoot, bridgeDataDirectory } from "@browserkit/tools/site-to-api";
import { has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { waitForBrowser } from "./browser-wait.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";
import { install } from "./install.js";
import { applyChromeFlags, defaultFlagEnv, undoChromeFlags, type FlagEnv } from "./chrome-flags.js";
import { login, modelLoginStatus } from "./model-login-cmd.js";
import { firstSixtySeconds, setupPrompts, terminalAsk } from "./setup-prompts.js";

// `aeon setup` installs the shim and the skill, then guides the user through the only manual step:
// loading the unpacked extension in Chrome. The script opens chrome://extensions, copies the folder
// and polls `aeon doctor` until the extension pairs. `aeon doctor` says what is still missing.

type Status = "ok" | "warn" | "fail";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function setup(host: DaemonHost, args: Args): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const say = (line: string) => process.stdout.write(line + "\n");
  const flagEnv = defaultFlagEnv(dataDirectory());
  if (has(args, "undo-flags") || has(args, "quiet-bar")) return flagsOnly(args, flagEnv);
  const script = join(root, "scripts", "setup.mjs");
  if (!existsSync(script)) {
    say(`Aeon setup script not found at ${script}.`);
    return 1;
  }
  const flags = [
    ...(has(args, "again") ? ["--again"] : ["--extension"]),
    ...(has(args, "yes") ? ["--yes"] : []),
    ...(has(args, "no-wait") ? ["--no-wait"] : []),
  ];
  if (!has(args, "again")) {
    const code = await install();
    if (code !== 0) return code;
    if (has(args, "no-register"))
      say("The native host is registered by Aeon's installer; nothing to skip.");
  }
  execFileSync(process.execPath, [script, ...flags], { cwd: root, stdio: "inherit" });
  await finishSetup(host, args, root, flagEnv);
  return 0;
}

function flagsOnly(args: Args, flagEnv: FlagEnv): number {
  const result = has(args, "undo-flags") ? undoChromeFlags(flagEnv) : applyChromeFlags(flagEnv);
  process.stdout.write(`${result.done ? "Done" : "Skipped"}: ${result.detail}.\n`);
  return result.done ? 0 : 1;
}

async function finishSetup(
  host: DaemonHost,
  args: Args,
  root: string,
  flagEnv: FlagEnv,
): Promise<void> {
  const say = (line: string) => process.stdout.write(line + "\n");
  const interactive = !has(args, "yes") && process.stdin.isTTY === true && !process.env.CI;
  const bridge = join(root, "browser", "apps", "bridge", "dist");
  const connectedModels = async () => (await modelLoginStatus()).connected.length;
  await setupPrompts({
    interactive,
    ask: terminalAsk(),
    say,
    applyFlags: () => applyChromeFlags(flagEnv),
    detectAgents: async () => {
      const table = (await import(pathToFileURL(join(bridge, "agent-table.js")).href)) as {
        agentTargets: () => { id: string }[];
      };
      return table.agentTargets().map((target) => target.id);
    },
    connectAgents: async () => {
      const { connectAgents } = (await import(
        pathToFileURL(join(bridge, "connect-agents.js")).href
      )) as {
        connectAgents: (server: {
          name: string;
          command: string;
          args: string[];
        }) => Promise<{ agent: string; done: boolean; detail: string }[]>;
      };
      const cli = join(root, "apps", "cli", "dist", "cli.js");
      for (const row of await connectAgents({
        name: "aeon",
        command: process.execPath,
        args: [cli, "mcp"],
      }))
        say(`   ${row.done ? "Connected" : "Could not connect"} ${row.agent} (${row.detail})`);
    },
    connectedModels,
    login: () => login(host, { positional: [], flags: {} }),
  });
  // Chats need a model; say how to connect one instead of letting the first chat fail.
  if (!interactive && (await connectedModels().catch(() => undefined)) === 0)
    say("Next: connect an AI model with `aeon login` (or Settings → Models in Aeon).");
  for (const line of firstSixtySeconds()) say(line);
}

async function doctor(host: DaemonHost): Promise<number> {
  const data = dataDirectory();
  const checks = [
    await dataCheck(data),
    await daemonCheck(data),
    await browserCheck(host),
    await sitesCheck(),
    await modelCheck(),
    await signInCheck(),
  ];
  return report(checks);
}

interface Check {
  status: Status;
  label: string;
  message: string;
}

async function dataCheck(data: string): Promise<Check> {
  const present = await exists(data);
  return {
    status: present ? "ok" : "warn",
    label: "data directory",
    message: present ? data : `${data} (created on first use)`,
  };
}

async function daemonCheck(data: string): Promise<Check> {
  const state = join(data, "core-connection.json");
  const present = await exists(state);
  return {
    status: present ? "ok" : "fail",
    label: "daemon",
    message: present ? state : "not running; open Chrome with Aeon loaded",
  };
}

async function browserCheck(host: DaemonHost): Promise<Check> {
  try {
    const client = await host.connect();
    const browsers = await waitForBrowser(() => client.settings(undefined));
    return {
      status: browsers.length ? "ok" : "fail",
      label: "browser connection",
      message: browsers.length
        ? `${browsers.length} browser${browsers.length === 1 ? "" : "s"} connected`
        : "no browser connected yet; it reconnects after a restart, otherwise reload Aeon at chrome://extensions",
    };
  } catch (error) {
    return {
      status: "fail",
      label: "browser connection",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sitesCheck(): Promise<Check> {
  const sites = await listSites().catch(() => []);
  return {
    status: sites.length ? "ok" : "warn",
    label: "mapped sites",
    message: sites.length ? `${sites.length} site(s) in ${registryRoot()}` : "none yet",
  };
}

async function modelCheck(): Promise<Check> {
  const status = await modelLoginStatus().catch(() => undefined);
  const names = status?.connected.map((provider) => provider.name) ?? [];
  return {
    status: names.length ? "ok" : "warn",
    label: "AI model",
    message: names.length
      ? `${names.join(", ")}${status?.defaultModel ? `; default ${status.defaultModel}` : ""}`
      : "none connected; run `aeon login`",
  };
}

async function signInCheck(): Promise<Check> {
  const provider = await activeProvider(bridgeDataDirectory()).catch(() => undefined);
  const state = provider ? await provider.status().catch((error: unknown) => String(error)) : "";
  return {
    status: state === "unlocked" ? "ok" : "warn",
    label: "password manager",
    message: provider ? `${provider.name}: ${state}` : "none; run `aeon signin setup bitwarden`",
  };
}

function report(checks: Check[]): number {
  const status: Status = checks.some((item) => item.status === "fail")
    ? "fail"
    : checks.some((item) => item.status === "warn")
      ? "warn"
      : "ok";
  process.stdout.write("aeon doctor\n");
  process.stdout.write(`Status: ${status}\n`);
  for (const item of checks)
    process.stdout.write(`[${item.status}] ${item.label}: ${item.message}\n`);
  if (status !== "ok")
    process.stdout.write(
      "Next: open Chrome with Aeon loaded (or reload it at chrome://extensions), then try `aeon status`.\n",
    );
  return status === "fail" ? 1 : 0;
}

export function setupCommands(host: DaemonHost): Command[] {
  return [
    {
      name: "setup",
      group: "Browser",
      summary: "finish setup by loading the Aeon extension in Chrome",
      help: `Usage: aeon setup [--no-register] [--again] [--yes] [--no-wait] [--quiet-bar] [--undo-flags]

Installs the aeon command and the Aeon skill, opens chrome://extensions, puts the extension
folder on your clipboard, prints the three clicks and waits until Aeon connects. No Chrome
flags are needed. --again repeats any missing install step (native host, service, extension).
--no-wait prints the clicks without waiting; --yes is the short, non-interactive wait for CI.
On a terminal it then offers opt-ins: coding-agent MCP, model sign-in and, last, optional
reversible Chrome launch flags. It ends with the first commands to run.
--quiet-bar adds the optional Chrome flags to your Chrome launcher (Linux .desktop, Windows
shortcuts, macOS "Aeon Chrome" app); --undo-flags removes them again.`,
      run: (args) => setup(host, args),
    },
    {
      name: "doctor",
      group: "Browser",
      summary: "check the install, the daemon and the browser connection",
      help: `Usage: aeon doctor`,
      run: () => doctor(host),
    },
  ];
}
