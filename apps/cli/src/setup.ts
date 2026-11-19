import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeProvider } from "@browserkit/credentials";
import { listSites, registryRoot, bridgeDataDirectory } from "@browserkit/tools/site-to-api";
import { has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { waitForBrowser } from "./browser-wait.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";
import { install } from "./install.js";

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

async function setup(args: Args): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const script = join(root, "scripts", "setup.mjs");
  if (!existsSync(script)) {
    process.stdout.write(`Aeon setup script not found at ${script}.\n`);
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
      process.stdout.write("The native host is registered by Aeon's installer; nothing to skip.\n");
  }
  execFileSync(process.execPath, [script, ...flags], { cwd: root, stdio: "inherit" });
  return 0;
}

async function doctor(host: DaemonHost): Promise<number> {
  const data = dataDirectory();
  const checks = [
    await dataCheck(data),
    await daemonCheck(data),
    await browserCheck(host),
    await sitesCheck(),
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
      help: `Usage: aeon setup [--no-register] [--again] [--yes] [--no-wait]

Installs the aeon command and the Aeon skill, opens chrome://extensions, puts the extension
folder on your clipboard, prints the three clicks and waits until Aeon connects. No Chrome
flags are needed. --again repeats any missing install step (native host, service, extension).
--no-wait prints the clicks without waiting; --yes is the short, non-interactive wait for CI.`,
      run: setup,
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
