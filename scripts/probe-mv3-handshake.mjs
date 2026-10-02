import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectCdp,
  connectHarness,
  openOptionsPage,
  parseAckStatus,
  readGrant,
  stopChild,
  waitForDebugPort,
  waitForExtension,
} from "./mv3-probe-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auditRoot = join(root, ".slice0-audit");
const extensionPath = join(root, "apps/chrome-extension/dev-dist");
const chromePath = process.env.PIPPIN_CHROME_PATH;
const evidencePath = join(auditRoot, "mv3-handshake-evidence-cft.json");

if (!chromePath)
  throw new Error("Set PIPPIN_CHROME_PATH to an isolated Chrome for Testing executable.");

const profilePath = await mkdtemp(join(auditRoot, "chrome-profile-mv3-"));
const daemon = spawn(
  process.execPath,
  [join(root, "apps/daemon/dist/main.js"), "--dev-handshake"],
  {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let browser;
let cdp;

try {
  const grant = await readGrant(daemon);
  browser = spawn(
    chromePath,
    [
      `--user-data-dir=${profilePath}`,
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-default-apps",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );

  const port = await waitForDebugPort(profilePath);
  const browserInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
    response.json(),
  );
  cdp = await connectCdp(browserInfo.webSocketDebuggerUrl);
  const extensionId = await waitForExtension(cdp.send);
  const page = await openOptionsPage(cdp.send, extensionId);
  const statuses = await connectHarness(cdp.send, page.sessionId, grant);
  const result = {
    probe: "mv3-typed-hello",
    browser: browserInfo.Browser,
    extensionId,
    profilePath,
    uiAck: parseAckStatus("ui", statuses.ui),
    extensionExecutorAck: parseAckStatus("extension-executor", statuses.executor),
  };

  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result)}\nEvidence: ${evidencePath}\n`);
} finally {
  if (cdp) {
    void cdp.send("Browser.close").catch(() => undefined);
    cdp.socket.close();
  }
  await stopChild(browser);
  await stopChild(daemon);
}
