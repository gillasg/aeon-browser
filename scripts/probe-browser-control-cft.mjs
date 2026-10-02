import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { connectCdp, stopChild, waitForDebugPort, waitForExtension } from "./mv3-probe-helpers.mjs";
import { CftNativeHostSetup } from "./probe-browser-control-cft-helpers.mjs";
import {
  attachPage,
  delay,
  installPageCommand,
  pageValue,
  safeFailureMessage,
  syntheticPage,
  waitUntil,
} from "./probe-browser-control-cft-browser.mjs";
import { runBrowserProbeChat } from "./probe-browser-control-cft-chat.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = join(
  root,
  ".slice0-audit",
  "chrome-for-testing-154.0.8037.57",
  "chrome-win64",
  "chrome.exe",
);
const nativeHostPath = join(root, "apps", "native-host", "dist", "pippin-native-host.exe");
const daemonEntrypoint = join(root, "apps", "daemon", "dist", "main.js");
const setup = new CftNativeHostSetup({
  root,
  chromePath,
  nativeHostPath,
  daemonEntrypoint,
  localAppData: process.env.LOCALAPPDATA,
});
const server = createServer((request, response) => {
  if (!request.url?.startsWith("/borrowed") && !request.url?.startsWith("/opened")) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(syntheticPage());
});
server.listen(0, "127.0.0.1");
await new Promise((resolveServer, reject) => {
  server.once("listening", resolveServer);
  server.once("error", reject);
});
const port = server.address().port;
const borrowedUrl = `http://127.0.0.1:${port}/borrowed`;
const openedUrl = `http://127.0.0.1:${port}/opened`;
let chrome;
let cdp;
let failure;
const workerDiagnostics = [];

try {
  await setup.prepare();
  chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${setup.profilePath}`,
      `--load-extension=${setup.extensionPath}`,
      `--disable-extensions-except=${setup.extensionPath}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-default-apps",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  const startupFailure = new Promise((_, reject) => {
    chrome.once("error", () => reject(new Error("Chrome for Testing failed to start.")));
    chrome.once("exit", (code) => {
      if (cdp === undefined)
        reject(new Error(`Chrome for Testing exited during startup (${code}).`));
    });
  });
  const debugPort = await Promise.race([waitForDebugPort(setup.profilePath), startupFailure]);
  const browserInfoResponse = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
    signal: globalThis.AbortSignal.timeout(5000),
  });
  if (!browserInfoResponse.ok)
    throw new Error("Chrome for Testing remote debugging did not respond.");
  const browserInfo = await browserInfoResponse.json();
  cdp = await connectCdp(browserInfo.webSocketDebuggerUrl);
  assert.equal(await waitForExtension(cdp.send), setup.extensionId);
  cdp.socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.method !== "Runtime.consoleAPICalled") return;
      const markers = (message.params.args ?? [])
        .filter((argument) => argument.type === "string")
        .map((argument) => argument.value)
        .filter((value) => typeof value === "string" && value.startsWith("PIPPIN_CFT_DIAG:"));
      workerDiagnostics.push(...markers.slice(0, 4));
    } catch {
      /* CDP diagnostics are optional and limited to the copied extension worker. */
    }
  });
  const workerTarget = (await cdp.send("Target.getTargets")).targetInfos.find(
    (target) => target.type === "service_worker" && target.url.endsWith("/service-worker.js"),
  );
  assert.ok(workerTarget, "the disposable extension worker is missing");
  const workerSession = await cdp.send("Target.attachToTarget", {
    targetId: workerTarget.targetId,
    flatten: true,
  });
  await cdp.send("Runtime.enable", {}, workerSession.sessionId);

  const home = await attachPage(cdp.send, `chrome-extension://${setup.extensionId}/home.html`);
  try {
    await waitUntil(
      () =>
        pageValue(
          cdp.send,
          home.sessionId,
          `document.getElementById("home-connection")?.textContent?.trim()`,
        ),
      (value) => value === "Connected",
      30_000,
      "native Home did not connect to the disposable daemon",
    );
  } catch {
    const status = await pageValue(
      cdp.send,
      home.sessionId,
      `({connection:document.getElementById("home-connection")?.textContent?.trim(), error:document.getElementById("home-error")?.textContent?.trim()})`,
    );
    throw new Error(
      `native Home did not connect (status=${status.connection ?? "missing"}; error=${status.error ?? "none"}; worker=${workerDiagnostics.join(",") || "no-diagnostic"})`,
    );
  }
  assert.ok(workerDiagnostics.includes("PIPPIN_CFT_DIAG:bootstrap-ok"));
  assert.ok(workerDiagnostics.includes("PIPPIN_CFT_DIAG:auth-auth.ready"));
  await waitUntil(
    () => workerDiagnostics.includes("PIPPIN_CFT_DIAG:inventory-ready"),
    Boolean,
    30_000,
    "native executor did not finish browser inventory synchronization",
  );
  await waitUntil(
    () =>
      workerDiagnostics.some((marker) => marker.startsWith("PIPPIN_CFT_DIAG:heartbeat-tick:")) &&
      workerDiagnostics.some((marker) => marker.startsWith("PIPPIN_CFT_DIAG:heartbeat-ack:")),
    Boolean,
    30_000,
    "native executor did not exchange a keepalive heartbeat",
  );
  await installPageCommand(cdp.send, home.sessionId);
  const created = await pageValue(
    cdp.send,
    home.sessionId,
    `window.__pippinCommand({kind:"catalog"},"chat.create",{title:"Slice 4 Browser Probe"})`,
  );
  assert.equal(created.kind, "command.completed");
  assert.equal(created.result.kind, "chat.created");
  const chatId = created.result.chat.chatId;
  process.stdout.write(
    JSON.stringify({ stage: "chat-created", browser: browserInfo.Browser, nativeConnected: true }) +
      "\n",
  );

  const chat = await attachPage(
    cdp.send,
    `chrome-extension://${setup.extensionId}/chat.html?chatId=${encodeURIComponent(chatId)}`,
  );
  await waitUntil(
    () =>
      pageValue(
        cdp.send,
        chat.sessionId,
        `document.getElementById("connection-state")?.dataset.state`,
      ),
    (value) => value === "connected",
    30_000,
    "probe Chat did not connect",
  );
  await installPageCommand(cdp.send, chat.sessionId);
  const modelResult = await pageValue(
    cdp.send,
    chat.sessionId,
    `window.__pippinCommand({kind:"chat",chatId:${JSON.stringify(chatId)}},"chat.model",{chatId:${JSON.stringify(chatId)},provider:"openai-codex",id:"gpt-6-luna"})`,
  );
  assert.equal(modelResult.kind, "command.completed");

  const borrowed = await attachPage(cdp.send, borrowedUrl);
  await cdp.send("Target.activateTarget", { targetId: borrowed.targetId });
  process.stdout.write(
    JSON.stringify({
      stage: "luna-browser-call-started",
      model: "openai-codex:gpt-6-luna",
      promptLogged: false,
      credentialsLogged: false,
    }) + "\n",
  );
  const submittedTurns = await runBrowserProbeChat({
    send: cdp.send,
    sessionId: chat.sessionId,
    chatId,
    borrowedUrl,
    openedUrl,
  });

  const browserState = await pageValue(
    cdp.send,
    borrowed.sessionId,
    `({marked:document.documentElement.dataset.marked==="yes", value:document.getElementById("result").value, scrollY:window.scrollY, url:location.href})`,
  );
  const buttonCount = await pageValue(
    cdp.send,
    borrowed.sessionId,
    `document.querySelectorAll("button").length`,
  );
  const targets = await cdp.send("Target.getTargets");
  const agentCreatedTabOpen = targets.targetInfos.some(
    (item) => item.type === "page" && item.url === openedUrl,
  );
  const chatEvidence = await pageValue(
    cdp.send,
    chat.sessionId,
    `(() => { const assistant = [...document.querySelectorAll(".message-row.assistant")].map(row => row.innerText).join("\\n"); const results = [...document.querySelectorAll(".activity-result")].map(row => row.innerText).join("\\n"); const text = assistant + "\\n" + results; const codes = [...new Set(text.match(/\\b(?:STALE_REF|AMBIGUOUS_TARGET|TARGET_LOST|CLAIM_CONFLICT|UNSUPPORTED|INVALID_TARGET|TIMEOUT|DAEMON_OFFLINE|OPERATION_FAILED|BROWSER_CONTROL_UNAVAILABLE)\\b/g) ?? [])]; const names = [...document.querySelectorAll(".activity-preview .step-name")].map(node => node.innerText.trim()); const flags = {cannot:/\\b(?:cannot|can't|unable|won't)\\b/i.test(assistant), unavailable:/\\b(?:unavailable|not available|not enabled|not supported)\\b/i.test(assistant), asksQuestion:/\\?/.test(assistant), mentionsTabs:/\\b(?:tabs|tab|Chrome|browser)\\b/i.test(assistant)}; return {assistantRows:document.querySelectorAll(".message-row.assistant").length, assistantLength:assistant.length, responseFlags:flags, toolCallCount:names.length, browserControlCalls:names.filter(name => name === "browser_control").length, otherToolCalls:names.filter(name => name !== "browser_control").length, mentionsBrowserTool:/browser_control/i.test(assistant), reportedCodes:codes, staleReported:codes.includes("STALE_REF"), ambiguityReported:codes.includes("AMBIGUOUS_TARGET")}; })()`,
  );
  const screenshot = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    borrowed.sessionId,
  );
  const evidencePath = join(root, "artifacts", "slice4-browser-synthetic-cft.png");
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, Buffer.from(screenshot.data, "base64"));
  process.stdout.write(
    JSON.stringify({
      stage: "browser-probe-evidence",
      browser: browserInfo.Browser,
      nativeConnected: true,
      model: "openai-codex:gpt-6-luna",
      submittedTurns: submittedTurns.turns,
      firstRunState: submittedTurns.firstRunState,
      secondRunState: submittedTurns.secondRunState,
      browserOperationTurnSettled: true,
      borrowedTabOpen: true,
      marked: browserState.marked,
      filled: browserState.value === "PIPPIN_SLICE4_OK",
      scrollY: browserState.scrollY,
      buttonCount,
      staleRefReported: chatEvidence.staleReported,
      ambiguousTargetReported: chatEvidence.ambiguityReported,
      reportedCodes: chatEvidence.reportedCodes,
      toolCallCount: chatEvidence.toolCallCount,
      browserControlCalls: chatEvidence.browserControlCalls,
      otherToolCalls: chatEvidence.otherToolCalls,
      assistantLength: chatEvidence.assistantLength,
      mentionsBrowserTool: chatEvidence.mentionsBrowserTool,
      responseFlags: chatEvidence.responseFlags,
      workerDiagnostics,
      agentCreatedTabOpen,
      assistantRows: chatEvidence.assistantRows,
      screenshot: evidencePath,
      promptOrCredentialLogged: false,
    }) + "\n",
  );
  assert.equal(
    browserState.url,
    borrowedUrl,
    "the borrowed tab navigated away from the synthetic page",
  );
  assert.equal(browserState.marked, true, "the borrowed synthetic page was not clicked");
  assert.equal(
    browserState.value,
    "PIPPIN_SLICE4_OK",
    "the borrowed synthetic textbox was not filled",
  );
  assert.ok(browserState.scrollY >= 300, "the borrowed synthetic page did not scroll");
  assert.equal(buttonCount, 3, "the synthetic ambiguity fixture changed");
  assert.ok(agentCreatedTabOpen, "browser_control did not leave its agent-created tab open");
  assert.ok(chatEvidence.assistantRows > 0, "Pi produced no assistant response");
  assert.ok(chatEvidence.staleReported, "Pi did not report the expected STALE_REF result");
  assert.ok(
    chatEvidence.ambiguityReported,
    "Pi did not report the expected AMBIGUOUS_TARGET result",
  );
} catch (error) {
  failure = error;
  process.stderr.write(
    JSON.stringify({
      probeFailed: true,
      message: safeFailureMessage(error),
      promptOrCredentialLogged: false,
    }) + "\n",
  );
} finally {
  if (cdp?.socket.readyState === WebSocket.OPEN) {
    try {
      await cdp.send("Browser.close");
    } catch {
      /* CFT may already have exited. */
    }
    cdp.socket.close();
  }
  if (chrome && chrome.exitCode === null)
    await Promise.race([
      new Promise((resolveExit) => chrome.once("exit", resolveExit)),
      delay(10_000),
    ]);
  if (chrome && chrome.exitCode === null) await stopChild(chrome);
  await new Promise((resolveClose) => server.close(resolveClose));
  await delay(1200);
  await setup.cleanup();
}
if (failure) process.exitCode = 1;
