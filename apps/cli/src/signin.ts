import {
  activeProvider,
  configFor,
  configPath,
  providerFor,
  readConfig,
  saveConfig,
  type BrowserCredentials,
  type CredentialConfig,
  type ProviderName,
} from "@browserkit/credentials";
import { bridgeDataDirectory } from "@browserkit/tools/site-to-api";
import { spawn } from "node:child_process";

// `aeon signin setup bitwarden|proton` picks the password manager Aeon signs in with;
// `aeon signin status` says which one answers. The agent then calls bu.signIn() on a sign-in
// page: the password goes from the password manager into the page, never through the agent.
// `--browser <name>` (a name from `aeon browsers`) gives one Chrome profile its own choice, such
// as an eval profile on a test vault while every other profile keeps the main one.

export const signinUsage = `  signin setup <provider> [--browser name]   bitwarden or proton: the password manager Aeon signs in with
                                             (--browser: only for that Chrome profile, see aeon browsers)
  signin status [--browser name]             show which password manager answers`;

export async function signinCommand(args: string[], browser?: string): Promise<number> {
  const [action = "status", name] = args;
  if (action === "status") return status(browser);
  if (action === "setup" && (name === "bitwarden" || name === "proton"))
    return setup(name, browser);
  process.stdout.write(signinUsage + "\n");
  return 1;
}

async function status(browser?: string): Promise<number> {
  const provider = await activeProvider(bridgeDataDirectory(), browser);
  const flag = browser ? ` --browser ${browser}` : "";
  if (!provider) {
    process.stdout.write(
      `No password manager answers${browser ? ` for ${browser}` : ""}. Run \`aeon signin setup bitwarden${flag}\` or \`aeon signin setup proton${flag}\`.\n`,
    );
    return 1;
  }
  const state = await provider.status().catch((error: unknown) => String(error));
  process.stdout.write(`${browser ? `${browser}: ` : ""}${provider.name}: ${state}\n`);
  return state === "unlocked" ? 0 : 1;
}

async function setup(name: ProviderName, browser?: string): Promise<number> {
  const directory = bridgeDataDirectory();
  const config = await readConfig(directory);
  const choice: BrowserCredentials = { ...configFor(config, browser), provider: name };
  if (name === "bitwarden") {
    process.stdout.write("Unlocking Bitwarden (`bw unlock --raw`); enter your master password.\n");
    const session = await unlockBitwarden();
    if (!session) {
      process.stderr.write("Bitwarden did not unlock. Run `bw login` first if needed.\n");
      return 1;
    }
    choice.bitwardenSession = session;
  } else delete choice.bitwardenSession;
  const state = await providerFor(name, choice)
    .status()
    .catch((error: unknown) => String(error));
  if (state !== "unlocked") {
    process.stderr.write(`${name} is not ready: ${state}\n`);
    return 1;
  }
  await saveConfig(directory, withChoice(config, choice, browser));
  const where = browser ? ` in the ${browser} profile` : "";
  process.stdout.write(
    `Aeon now signs in with ${name}${where}. Saved to ${configPath(directory)}\n`,
  );
  return 0;
}

/** The config with one browser's choice (or the top-level one) replaced. */
export function withChoice(
  config: CredentialConfig,
  choice: BrowserCredentials,
  browser?: string,
): CredentialConfig {
  if (browser) return { ...config, browsers: { ...config.browsers, [browser]: choice } };
  const { browsers } = config;
  return { ...choice, ...(browsers ? { browsers } : {}) };
}

function unlockBitwarden(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // One command string with no argument array: on Windows `bw` is a .cmd shim that needs a
    // shell, and Node warns when a shell is given separate arguments.
    const child = spawn("bw unlock --raw", [], {
      stdio: ["inherit", "pipe", "inherit"],
      shell: true,
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 && text.trim() ? text.trim() : undefined));
  });
}
