import {
  activeProvider,
  configPath,
  providerFor,
  readConfig,
  saveConfig,
  type ProviderName,
} from "@browserkit/credentials";
import { bridgeDataDirectory } from "@browserkit/tools/site-to-api";
import { spawn } from "node:child_process";

// `aeon signin setup bitwarden|proton` picks the password manager Aeon signs in with;
// `aeon signin status` says which one answers. The agent then calls bu.signIn() on a sign-in
// page: the password goes from the password manager into the page, never through the agent.

export const signinUsage = `  signin setup <provider>       bitwarden or proton: the password manager Aeon signs in with
  signin status                 show which password manager answers`;

export async function signinCommand(args: string[]): Promise<number> {
  const [action = "status", name] = args;
  if (action === "status") return status();
  if (action === "setup" && (name === "bitwarden" || name === "proton")) return setup(name);
  process.stdout.write(signinUsage + "\n");
  return 1;
}

async function status(): Promise<number> {
  const provider = await activeProvider(bridgeDataDirectory());
  if (!provider) {
    process.stdout.write(
      "No password manager answers. Run `aeon signin setup bitwarden` or `aeon signin setup proton`.\n",
    );
    return 1;
  }
  const state = await provider.status().catch((error: unknown) => String(error));
  process.stdout.write(`${provider.name}: ${state}\n`);
  return state === "unlocked" ? 0 : 1;
}

async function setup(name: ProviderName): Promise<number> {
  const directory = bridgeDataDirectory();
  const config = await readConfig(directory);
  if (name === "bitwarden") {
    process.stdout.write("Unlocking Bitwarden (`bw unlock --raw`); enter your master password.\n");
    const session = await unlockBitwarden();
    if (!session) {
      process.stderr.write("Bitwarden did not unlock. Run `bw login` first if needed.\n");
      return 1;
    }
    config.bitwardenSession = session;
  } else delete config.bitwardenSession;
  config.provider = name;
  const state = await providerFor(name, config)
    .status()
    .catch((error: unknown) => String(error));
  if (state !== "unlocked") {
    process.stderr.write(`${name} is not ready: ${state}\n`);
    return 1;
  }
  await saveConfig(directory, config);
  process.stdout.write(`Aeon now signs in with ${name}. Saved to ${configPath(directory)}\n`);
  return 0;
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
