import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { captureSidePanel } from "./capture-slice-2-sidepanel.mjs";
import { reactInputAssignment, waitForHomeModel } from "./capture-slice-2-home.mjs";
import { nativeChromeCaptureEvidence } from "./capture-native-evidence.mjs";
import { connectCdp, readGrant, stopChild, waitForDebugPort } from "./mv3-probe-helpers.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const extensionPath = join(root, "apps/chrome-extension/dev-dist");
const screenshotDirectory = join(root, "artifacts/slice-2");
const chromePath =
  process.env.PIPPIN_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dataDirectory = await mkdtemp(join(tmpdir(), "pippin-slice2-data-"));
const profileDirectory = await mkdtemp(join(tmpdir(), "pippin-slice2-chrome-"));
const daemon = spawn(process.execPath, [join(root, "apps/daemon/dist/main.js"), "--dev-chat"], {
  cwd: root,
  env: {
    ...process.env,
    PIPPIN_DEV_DATA_DIR: dataDirectory,
    PIPPIN_FIXTURE_TOKENS_PER_SECOND: "4",
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const grant = await readGrant(daemon);
const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profileDirectory}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--window-size=1600,900",
    "--window-position=100,80",
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const chromeExit = new Promise((resolveExit) => chrome.once("exit", resolveExit));
let browser;
const pages = [];

try {
  await mkdir(screenshotDirectory, { recursive: true });
  const profilePort = await waitForDebugPort(profileDirectory);
  const version = await fetch(`http://127.0.0.1:${profilePort}/json/version`).then((response) =>
    response.json(),
  );
  browser = await connectCdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", {
    path: extensionPath,
    enableInIncognito: false,
  });
  const extensionId = loaded.id;
  const options = await newPage(`chrome-extension://${extensionId}/options.html`, 1200, 800);
  await options.wait("document.readyState === 'complete'");
  await options.evaluate(
    `(() => { const input = document.getElementById('grant'); input.value = ${JSON.stringify(grant)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('connect-form').requestSubmit(); return true; })()`,
  );
  await options.wait("!document.getElementById('chat-launcher').hidden");

  if (process.argv.includes("--native-shell")) {
    await browser.send("Target.createTarget", { url: "about:blank" });
    process.stdout.write(
      "Isolated Chrome shell is ready. Use Chrome's New Tab gesture and extension action, then send one byte on stdin to clean up.\n",
    );
    await new Promise((resolveInput) => {
      process.stdin.once("data", resolveInput);
      process.stdin.once("end", resolveInput);
      process.stdin.resume();
    });
  } else {
    const home = await newPage(`chrome-extension://${extensionId}/home.html`, 1443, 811);
    await home.wait("document.getElementById('home-connection').textContent === 'Connected'");
    await waitForHomeModel(home);
    await hideFixtureBadge(home);
    await home.capture("new-tab-home-empty-page-only.png");

    await home.evaluate(
      `(() => { ${reactInputAssignment("home-query", "Create a concise checklist for the local fixture")} document.getElementById('home-form').requestSubmit(); return true; })()`,
    );
    const chatTarget = await waitForTarget((target) => target.url.includes("/chat.html?chatId="));
    const chat = await attachPage(chatTarget.targetId, 1443, 811);
    await chat.wait("document.getElementById('connection-state').dataset.state === 'connected'");
    await hideFixtureBadge(chat);
    await chat.wait("document.getElementById('chat-sidebar').hidden");
    await chat.wait("!document.getElementById('run-indicator').hidden", 8_000);
    await chat.evaluate("document.getElementById('sidebar-toggle').click()");
    await chat.wait(
      "!document.getElementById('chat-sidebar').hidden && !document.getElementById('run-indicator').hidden && document.querySelector('.app-shell').dataset.sidebarOpen === 'true'",
    );
    await delay(200);
    const openLayout = await chat.evaluate(
      `(() => { const rect = (selector) => { const node = document.querySelector(selector); const box = node.getBoundingClientRect(); return {left: box.left, right: box.right, width: box.width}; }; return {viewport: innerWidth, sidebar: rect('#chat-sidebar'), main: rect('.chat-main'), composer: rect('#composer'), controls: rect('.composer-meta')}; })()`,
    );
    if (
      openLayout.main.left < openLayout.sidebar.right ||
      openLayout.composer.left < openLayout.sidebar.right ||
      openLayout.composer.right > openLayout.viewport ||
      openLayout.controls.right > openLayout.viewport
    )
      throw new Error(`The open Chat sidebar clips content: ${JSON.stringify(openLayout)}`);
    await chat.capture("chat-full-sidebar-active-run-page-only.png");
    await chat.wait(
      "document.querySelector('.message-row.assistant .message-text')?.textContent?.includes('Local fixture response 1') && document.getElementById('run-indicator').hidden",
      20_000,
    );
    await chat.evaluate("document.getElementById('sidebar-close').click()");
    await chat.wait("document.getElementById('chat-sidebar').hidden");
    await chat.capture("chat-full-sidebar-closed-page-only.png");
    await chat.evaluate("document.getElementById('sidebar-toggle').click()");
    await chat.wait("!document.getElementById('chat-sidebar').hidden");
    await chat.capture("chat-full-sidebar-open-page-only.png");
    await chat.evaluate("document.getElementById('sidebar-close').click()");
    await chat.setViewport(600, 811);
    await chat.evaluate("document.getElementById('sidebar-toggle').click()");
    await chat.wait(
      "document.getElementById('chat-sidebar').getAttribute('aria-modal') === 'true' && !document.getElementById('sidebar-scrim').hidden && document.querySelector('.chat-main').getBoundingClientRect().left === 0",
    );
    await chat.capture("chat-sidebar-mobile-modal-page-only.png");
    const chatId = new URL(chatTarget.url).searchParams.get("chatId");

    const catalog = await newPage(`chrome-extension://${extensionId}/home.html`, 1443, 811);
    await catalog.wait("document.getElementById('home-connection').textContent === 'Connected'");
    await catalog.evaluate("document.getElementById('home-all-chats').click()");
    await catalog.wait("Boolean(document.getElementById('home-catalog'))");
    await catalog.evaluate(
      `(() => { ${reactInputAssignment("catalog-query", "local fixture response")} return true; })()`,
    );
    await catalog.wait(
      "document.querySelector('.catalog-result-preview')?.textContent?.includes('Local fixture response')",
      15_000,
    );
    await hideFixtureBadge(catalog);
    await catalog.capture("chat-catalog-message-search-page-only.png");
    await catalog.evaluate(
      `([...document.querySelectorAll('.catalog-result-actions button')].find((button) => button.textContent === 'Pin')).click()`,
    );
    await catalog.wait(
      "document.querySelector('.catalog-result-meta')?.textContent?.includes('Pinned')",
    );

    const secondHome = await newPage(`chrome-extension://${extensionId}/home.html`, 1443, 811);
    await secondHome.wait("document.getElementById('home-connection').textContent === 'Connected'");
    await waitForHomeModel(secondHome);
    await secondHome.evaluate(
      `(() => { ${reactInputAssignment("home-query", "Prepare a browser test plan")} document.getElementById('home-form').requestSubmit(); return true; })()`,
    );
    await secondHome.wait(
      "document.getElementById('composer') && document.getElementById('connection-state').dataset.state === 'connected'",
      15_000,
    );
    await secondHome.wait(
      "document.querySelector('.message-row.assistant .message-text')?.textContent?.includes('Local fixture response') && document.getElementById('run-indicator').hidden",
      20_000,
    );
    const populatedHome = await newPage(`chrome-extension://${extensionId}/home.html`, 1443, 811);
    await populatedHome.wait(
      "document.getElementById('home-connection').textContent === 'Connected'",
    );
    await waitForHomeModel(populatedHome);
    await populatedHome.wait(
      "document.querySelectorAll('.home-chat-card').length >= 2 && document.querySelectorAll('#pinned-chats .home-chat-row').length === 1 && document.querySelectorAll('#recent-chats .home-chat-row').length === 1",
    );
    const homeLayout = await populatedHome.evaluate(
      `(() => { const rect = (selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return {left: box.left, right: box.right, width: box.width}; }; return {viewport: {width: innerWidth, height: innerHeight}, sidebar: rect('.home-sidebar'), main: rect('.home-main'), cards: rect('#home-cards')}; })()`,
    );
    await hideFixtureBadge(populatedHome);
    await populatedHome.capture("new-tab-home-page-only.png");

    const sidePanelMeasurements = await captureSidePanel({
      attachPage,
      browser,
      chatId,
      extensionId,
      newPage,
      waitForTarget,
    });

    const evidence = {
      browser: version.Browser,
      extensionId,
      screenshots: [
        "new-tab-home-page-only.png",
        "new-tab-home-empty-page-only.png",
        "chat-catalog-message-search-page-only.png",
        "chat-full-sidebar-closed-page-only.png",
        "chat-full-sidebar-open-page-only.png",
        "chat-full-sidebar-active-run-page-only.png",
        "chat-sidebar-mobile-modal-page-only.png",
        "side-panel-380px-page-only.png",
        "side-panel-picker-open-page-only.png",
        "side-panel-320px-page-only.png",
        nativeChromeCaptureEvidence.newTab.noticeScreenshot,
        nativeChromeCaptureEvidence.newTab.screenshot,
        nativeChromeCaptureEvidence.nativePanel.screenshot,
      ],
      captures: "CDP screenshots omit Chrome's frame; nativeChrome screenshots include the shell.",
      newTabOverride:
        "The MV3 manifest declares home.html as the New Tab override. The page-only capture opened that extension page directly; nativeChrome records Chrome's New Tab button.",
      sidePanel:
        "The page-only capture records compact-width geometry; nativeChrome records the live Chrome toolbar side panel.",
      nativeChrome: nativeChromeCaptureEvidence,
      measurements: {
        homePage: homeLayout,
        chatSidebarOpen: openLayout,
        sidePanel: sidePanelMeasurements,
      },
    };
    await (
      await import("node:fs/promises")
    ).writeFile(
      join(screenshotDirectory, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify(evidence, null, 2)}\nScreenshots: ${screenshotDirectory}\n`,
    );
    for (const page of pages) page.close();
  }
} finally {
  if (browser) {
    await browser.send("Browser.close").catch(() => undefined);
    browser.socket.close();
  }
  await Promise.all([stopChild(chrome), stopChild(daemon)]);
  await Promise.race([chromeExit, delay(3000)]);
  if (profileDirectory.startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
  if (dataDirectory.startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined);
}

async function newPage(url, width, height) {
  const { targetId } = await browser.send("Target.createTarget", { url });
  return attachPage(targetId, width, height);
}

async function attachPage(targetId, width, height) {
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => browser.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  const page = {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.text ?? "Page script failed.");
      return result.result.value;
    },
    async wait(expression, timeout = 10_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await page.evaluate(expression)) return;
        } catch {
          // Chrome may still be navigating the extension page.
        }
        await delay(100);
      }
      throw new Error(`Timed out waiting for page condition: ${expression}`);
    },
    async capture(name) {
      const image = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(screenshotDirectory, name), Buffer.from(image.data, "base64"));
    },
    async setViewport(nextWidth, nextHeight) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: nextWidth,
        height: nextHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });
    },
    close() {
      void browser.send("Target.closeTarget", { targetId }).catch(() => undefined);
    },
  };
  pages.push(page);
  await page.setViewport(width, height);
  return page;
}

async function waitForTarget(predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.send("Target.getTargets");
    const found = targetInfos.find((target) => target.type === "page" && predicate(target));
    if (found) return found;
    await delay(100);
  }
  throw new Error("Timed out waiting for the Chrome extension page.");
}

async function hideFixtureBadge(page) {
  await page.evaluate(
    "document.querySelectorAll('.fixture-badge,.home-sidebar-footer,.sidebar-footer,#home-connection,#connection-state').forEach((item) => item.style.display = 'none')",
  );
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
