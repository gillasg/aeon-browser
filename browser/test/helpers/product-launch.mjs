// Launches Chrome for Testing the way users run it: the extension loaded, nothing else. No
// --remote-debugging-port or pipe, no --enable-automation. The native-messaging manifest goes
// into the profile's own NativeMessagingHosts folder, and everything is driven through the
// bridge and the native host, as in the product. With no display, a private Xvfb is started.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const here = resolve(import.meta.dirname, "../..");
const cli = join(here, "apps/bridge/dist/cli.js");
const extension = join(here, "apps/extension/build");
const NATIVE_HOST = "com.browserkit.bridge";
const EXTENSION_ID = "dmlgohfphkbenjopdphcojgjeidlmajj";

export const chromePath =
  process.env.CHROME_PATH ??
  join(
    process.env.HOME ?? "",
    ".cache/chrome-for-testing/linux-157.0.8103.78/chrome-linux64/chrome",
  );

export const canLaunch = existsSync(chromePath) && existsSync(cli);

/** The exact flags the product uses: an extension, a profile, nothing that marks automation. */
export function productArgs(profile, headless) {
  return [
    `--user-data-dir=${profile}`,
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    // Test machines without user namespaces need this; it changes nothing a page can see.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

async function display() {
  if (process.platform !== "linux" || process.env.DISPLAY) return { env: {}, stop() {} };
  if (!existsSync("/usr/bin/Xvfb")) return { env: {}, headless: true, stop() {} };
  const number = 90 + Math.floor(Math.random() * 400);
  const xvfb = spawn(
    "/usr/bin/Xvfb",
    [`:${number}`, "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
    {
      stdio: "ignore",
    },
  );
  await sleep(500);
  return { env: { DISPLAY: `:${number}` }, stop: () => xvfb.kill() };
}

async function installNativeHost(profile, home) {
  const folder = join(profile, "NativeMessagingHosts");
  await mkdir(folder, { recursive: true });
  const launcher = join(home, "host.sh");
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  await chmod(launcher, 0o755);
  await writeFile(
    join(folder, `${NATIVE_HOST}.json`),
    JSON.stringify({
      name: NATIVE_HOST,
      description: "browserkit bridge",
      path: launcher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    }),
  );
}

export async function waitFor(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(200);
    }
  }
  throw last ?? new Error("timed out");
}

/** Chrome, launched as users launch it, with a bridge to drive it. */
export async function launchProduct(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "product-launch-"));
  const profile = await mkdtemp(join(tmpdir(), "product-launch-chrome-"));
  const screen = options.headless ? { env: {}, headless: true, stop() {} } : await display();
  const env = {
    ...process.env,
    ...screen.env,
    BROWSERKIT_HOME: home,
    SITE_TO_API_HOME: join(home, "s2a"),
    ...(options.env ?? {}),
  };
  await installNativeHost(profile, home);
  const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
  await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
  const args = productArgs(profile, screen.headless === true);
  const chrome = spawn(chromePath, args, { env, stdio: "ignore" });
  const status = async () => (await run(process.execPath, [cli, "status"], { env })).stdout;
  await waitFor(async () => {
    const out = await status();
    if (!/1 browser/.test(out)) throw new Error(out);
  }, 60_000);
  return {
    args,
    env,
    home,
    /** Runs one browser-code cell through the bridge; returns stdout. */
    async repl(code, session = "product-launch") {
      const result = await run(process.execPath, [cli, "repl", "--session", session, code], {
        env,
        maxBuffer: 16 * 1024 * 1024,
      });
      return result.stdout;
    },
    async close() {
      chrome.kill();
      bridge.kill();
      screen.stop();
      await sleep(300);
      for (const dir of [profile, home])
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
          () => {},
        );
    },
  };
}
