import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAeonModelRuntime, resolvePiAgentDirectory } from "@aeon/pi-adapter";
import { has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { aeonExtensionId, extensionIdFromKey, extensionUrl } from "./extension-url.js";
import type { DaemonHost } from "./host.js";

export { extensionIdFromKey };

// `aeon login` connects an AI model the same way the extension does: it opens Aeon's Models page
// (Settings → Models) in the connected Chrome and waits until a model answers. Logins land in Pi's
// auth.json, so chats, this CLI and the Pi CLI all see them. `aeon login status` only reports.

export interface ModelLoginStatus {
  connected: { id: string; name: string; source?: string }[];
  defaultModel?: string;
}

/** Which providers answer and the default model, read from Pi's own files. */
export async function modelLoginStatus(agentDirectory?: string): Promise<ModelLoginStatus> {
  const directory = agentDirectory ?? resolvePiAgentDirectory();
  const models = await createAeonModelRuntime({ agentDirectory: directory });
  const connected: ModelLoginStatus["connected"] = [];
  for (const provider of models.getProviders()) {
    const check = await models.checkAuth(provider.id).catch(() => undefined);
    if (check)
      connected.push({
        id: provider.id,
        name: provider.name,
        ...(check.source ? { source: check.source } : {}),
      });
  }
  const settings = await readFile(join(directory, "settings.json"), "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);
  const { defaultProvider, defaultModel } = settings;
  return typeof defaultProvider === "string" && typeof defaultModel === "string"
    ? { connected, defaultModel: `${defaultProvider}/${defaultModel}` }
    : { connected };
}

export function describeStatus(status: ModelLoginStatus): string {
  if (!status.connected.length)
    return "No AI model is connected yet. Run `aeon login` to sign in from Aeon's Models page.\n";
  const lines = status.connected.map(
    (provider) => `  ${provider.name}${provider.source ? ` (from ${provider.source})` : ""}`,
  );
  const fallback = "each app picks (set one in Settings → Models)";
  return `Connected:\n${lines.join("\n")}\nDefault model: ${status.defaultModel ?? fallback}\n`;
}

async function modelsPageUrl(): Promise<string> {
  return extensionUrl(await aeonExtensionId(), "home.html?view=models");
}

const WAIT_MS = 10 * 60_000;
const POLL_MS = 3_000;

export async function login(host: DaemonHost, args: Args): Promise<number> {
  const action = args.positional[0];
  const before = await modelLoginStatus();
  if (action === "status") {
    process.stdout.write(describeStatus(before));
    return before.connected.length ? 0 : 1;
  }
  if (action !== undefined) {
    process.stdout.write(loginUsage + "\n");
    return 1;
  }
  const url = await modelsPageUrl();
  try {
    await host.runInBrowser(
      `await browser.keepPage(${JSON.stringify(url)}, { foreground: true }); "opened"`,
      { session: "cli-login", timeoutMs: 20_000 },
    );
    process.stdout.write("Opened Aeon's Models page in Chrome. Sign in or add an API key there.\n");
  } catch {
    process.stdout.write(
      `Could not reach Chrome. Open Chrome with Aeon loaded, then go to Settings → Models\n(${url}).\n`,
    );
    return before.connected.length ? 0 : 1;
  }
  if (has(args, "no-wait")) return 0;
  const known = new Set(before.connected.map((provider) => provider.id));
  process.stdout.write("Waiting for the sign-in to finish (Ctrl+C to stop)…\n");
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, POLL_MS));
    const now = await modelLoginStatus().catch(() => before);
    const added = now.connected.filter((provider) => !known.has(provider.id));
    if (added.length) {
      process.stdout.write(`Connected to ${added.map((provider) => provider.name).join(", ")}.\n`);
      process.stdout.write(describeStatus(now));
      return 0;
    }
  }
  process.stdout.write("Still no new model. Run `aeon login status` once you have signed in.\n");
  return before.connected.length ? 0 : 1;
}

export const loginUsage = `Usage: aeon login [--no-wait]
       aeon login status

Connects an AI model: opens Aeon's Models page in Chrome (subscriptions such as Claude, ChatGPT
or GitHub Copilot, or an API key for 40+ providers) and waits until the new model answers. The
first model connected becomes the default. status lists the connected providers and the default.`;

export function loginCommands(host: DaemonHost): Command[] {
  return [
    {
      name: "login",
      group: "Aeon",
      summary: "connect an AI model (opens Aeon's Models page)",
      help: loginUsage,
      run: (args) => login(host, args),
    },
  ];
}
