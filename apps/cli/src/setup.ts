import { access } from "node:fs/promises";
import { join } from "node:path";
import { activeProvider } from "@browserkit/credentials";
import { listSites, registryRoot, bridgeDataDirectory } from "@browserkit/tools/site-to-api";
import { has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";
import { install } from "./install.js";

// `aeon setup` is `aeon install` (the shim and the skill; the native host installs it too), and
// `aeon doctor` says which piece is missing, like browserkit's own doctor does.

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
  const code = await install();
  if (has(args, "no-register"))
    process.stdout.write("The native host is registered by Aeon's installer; nothing to skip.\n");
  process.stdout.write("Next: keep Chrome open with Aeon loaded, then try `aeon status`.\n");
  return code;
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
    const browsers = await (await host.connect()).settings(undefined);
    return {
      status: browsers.length ? "ok" : "fail",
      label: "browser connection",
      message: browsers.length
        ? `${browsers.length} browser${browsers.length === 1 ? "" : "s"} connected`
        : "no browser connected; reload Aeon at chrome://extensions",
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
      summary: "install the aeon command and the Aeon skill for agents",
      help: `Usage: aeon setup [--no-register]

Puts the aeon command on the PATH and links the Aeon skill into ~/.agents/skills (and
~/.claude/skills). Aeon's native host runs the same install; --no-register is accepted for
symmetry with browserkit.`,
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
