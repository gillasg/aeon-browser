import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pageValue, waitUntil } from "./probe-browser-control-cft-browser.mjs";
import { openExtensionHome } from "./probe-slice8-handoff-helpers.mjs";
import { isSidePanelTarget, summarizeExtensionTargets } from "./probe-side-panel-targets.mjs";

export function chromeFlags(configuration) {
  return [
    `--user-data-dir=${configuration.profilePath}`,
    `--load-extension=${configuration.extensionPath}`,
    `--disable-extensions-except=${configuration.extensionPath}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
    "--window-size=1600,900",
  ];
}

export async function attachExtensionWorker(send, extensionId) {
  let target;
  await waitUntil(
    async () => {
      target = (await send("Target.getTargets")).targetInfos.find(
        (item) =>
          item.type === "service_worker" &&
          item.url === `chrome-extension://${extensionId}/service-worker.js`,
      );
      return target;
    },
    Boolean,
    15_000,
    "the disposable extension worker did not start",
  );
  const session = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await send("Runtime.enable", {}, session.sessionId);
  return session;
}

export async function openNewTab(send, extensionId) {
  const homeUrl = `chrome-extension://${extensionId}/home.html`;
  const created = await send("Target.createTarget", { url: "chrome://newtab/" });
  const overrideActive = await resolvesToExtensionHome(send, created.targetId, homeUrl);
  if (!overrideActive) {
    await send("Target.closeTarget", { targetId: created.targetId });
    const home = await openExtensionHome(send, extensionId);
    return { session: { sessionId: home.sessionId }, overrideActive };
  }
  const session = await send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  await send("Runtime.enable", {}, session.sessionId);
  await send("Page.enable", {}, session.sessionId);
  await waitUntil(
    () => pageValue(send, session.sessionId, "globalThis.location?.href"),
    (url) => url === homeUrl,
    15_000,
    "Chrome did not finish loading the New Tab override",
  );
  return { session, overrideActive };
}

async function resolvesToExtensionHome(send, targetId, homeUrl) {
  try {
    await waitUntil(
      async () => {
        const target = (await send("Target.getTargets")).targetInfos.find(
          (item) => item.targetId === targetId,
        );
        return target?.url;
      },
      (url) => url === homeUrl,
      5_000,
      "New Tab override is unavailable",
    );
    return true;
  } catch {
    return false;
  }
}

export async function openHomePicker(send, sessionId, id) {
  return pageValue(
    send,
    sessionId,
    `(() => { const summary=document.getElementById(${JSON.stringify(id)}); const details=summary?.closest("details"); if (!summary || !details) throw new Error("HOME_PICKER_MISSING"); if (!details.open) summary.click(); return [...details.querySelectorAll('button[role="option"]')].map((option)=>({text:option.innerText.trim(),provider:option.closest(".pi-picker-group")?.getAttribute("aria-label")??null,id:option.getAttribute("data-model-id")??null})); })()`,
    30_000,
    `Open ${id}`,
  );
}

export async function chooseHomeModel(send, sessionId, provider, id) {
  await pageValue(
    send,
    sessionId,
    `(() => { const summary=document.getElementById("home-model-picker"); const details=summary?.closest("details"); const search=details?.querySelector('input[type="search"]'); if (!summary || !details || !search) throw new Error("HOME_MODEL_PICKER_MISSING"); if (!details.open) summary.click(); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; setter.call(search,${JSON.stringify(id)}); search.dispatchEvent(new Event("input",{bubbles:true})); return true; })()`,
    30_000,
    "Filter dynamic Pi model list",
  );
  await waitUntil(
    () =>
      pageValue(
        send,
        sessionId,
        `(() => { const details=document.getElementById("home-model-picker")?.closest("details"); const search=details?.querySelector('input[type="search"]'); const options=[...(details?.querySelectorAll('button[role="option"]')??[])].map((item)=>({provider:item.closest(".pi-picker-group")?.getAttribute("aria-label"),id:item.getAttribute("data-model-id")})); return {query:search?.value,options}; })()`,
      ),
    (state) =>
      state.query === id &&
      state.options.length > 0 &&
      state.options.every((option) => option.id === id) &&
      state.options.some((option) => option.provider === provider),
    5_000,
    "Pi model search did not render the selected catalog option",
  );
  const selected = await pageValue(
    send,
    sessionId,
    `(() => { const summary=document.getElementById("home-model-picker"); const details=summary?.closest("details"); const option=[...(details?.querySelectorAll('button[role="option"]')??[])].find((item)=>item.closest(".pi-picker-group")?.getAttribute("aria-label")===${JSON.stringify(provider)}&&item.getAttribute("data-model-id")===${JSON.stringify(id)}); if (!summary || !details || !option) throw new Error("HOME_MODEL_OPTION_MISSING"); const name=option.querySelector("span")?.textContent?.trim()??""; option.click(); return {provider:${JSON.stringify(provider)},id:${JSON.stringify(id)},label:name}; })()`,
    30_000,
    "Choose dynamic Pi model",
  );
  await waitForText(
    send,
    sessionId,
    `document.getElementById("home-model-picker")?.firstElementChild?.textContent?.trim()`,
    selected.label,
    "Selected Pi model did not render",
    "home model selection update",
  );
  return selected;
}
export async function chooseHomeEffort(send, sessionId, level) {
  await pageValue(
    send,
    sessionId,
    `(() => { const summary=document.getElementById("home-thinking-picker"); const details=summary?.closest("details"); if (!summary || !details) throw new Error("HOME_EFFORT_PICKER_MISSING"); if (!details.open) summary.click(); const options=[...details.querySelectorAll('button[role="option"]')]; const option=options.find((item)=>item.textContent.trim().toLowerCase()===${JSON.stringify(level)}); if (!option) throw new Error("HOME_EFFORT_OPTION_MISSING"); option.click(); return options.map((item)=>item.textContent.trim().toLowerCase()); })()`,
    30_000,
    "Choose supported Pi effort",
  );
  await waitForText(
    send,
    sessionId,
    `document.getElementById("home-thinking-picker")?.firstElementChild?.textContent?.trim()`,
    level.charAt(0).toUpperCase() + level.slice(1),
    "Selected Pi effort did not render",
    "home effort selection update",
  );
  const selected = await pageValue(
    send,
    sessionId,
    `document.getElementById("home-thinking-picker")?.firstElementChild?.textContent?.trim()`,
  );
  return { selected: selected.toLowerCase() };
}

export async function waitForChatTarget(send, extensionId) {
  let found;
  await waitUntil(
    async () => {
      found = (await send("Target.getTargets")).targetInfos.find(
        (target) =>
          target.type === "page" &&
          target.url.startsWith(`chrome-extension://${extensionId}/chat.html?chatId=`),
      );
      return found;
    },
    Boolean,
    30_000,
    "New Tab did not route to its Chat",
  );
  return found;
}

export async function waitForText(send, sessionId, expression, expected, message, stage = message) {
  await waitUntil(
    () => pageValue(send, sessionId, expression, 30_000, stage),
    (value) => value === expected,
    30_000,
    message,
  );
}

export function commandExpression(chatId, operation, payload) {
  return `window.__pippinCommand({kind:"chat",chatId:${JSON.stringify(chatId)}},${JSON.stringify(operation)},${JSON.stringify(payload)})`;
}

export function toolEvidenceSummary() {
  return `(() => { const rows=[...document.querySelectorAll(".activity-step")]; rows.forEach((row)=>{row.closest(".activity-card")?.setAttribute("open","");row.closest(".activity-bundle")?.setAttribute("open","");row.open=true}); const results=rows.flatMap(row=>[...row.querySelectorAll(".step-detail,.structured-tool-result")].map(node=>node.textContent??"")); const text=rows.map(row=>row.textContent??"").join("\\n"); document.querySelector(".tool-images")?.scrollIntoView({block:"center"}); return {imageStates:[...document.querySelectorAll(".tool-images")].map(node=>node.textContent.trim().slice(0,160)),imageContainers:document.querySelectorAll(".tool-images").length,imagePreviewReady:[...document.querySelectorAll(".tool-images img")].some(img=>img.naturalWidth>0),stepCount:rows.length,resultCount:results.length,staleReference:text.includes("STALE_REF"),ambiguousTarget:text.includes("AMBIGUOUS_TARGET")}; })()`;
}

export async function openSidePanel(send, workerSessionId, tabId) {
  const result = await send(
    "Runtime.evaluate",
    {
      expression: `chrome.sidePanel.open({tabId:${tabId}}).then(()=>true)`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    workerSessionId,
  );
  if (result.exceptionDetails) throw new Error("Chrome could not open the extension side panel.");
}

export async function attachSidePanel(send, extensionId, onTargetScan = async () => {}) {
  let target;
  let lastSummary;
  let lastSummaryKey;
  await waitUntil(
    async () => {
      const targets = (await send("Target.getTargets")).targetInfos;
      target = targets.find((item) => isSidePanelTarget(item, extensionId));
      const summary = summarizeExtensionTargets(targets, extensionId);
      const summaryKey = JSON.stringify(summary);
      if (summaryKey !== lastSummaryKey) {
        lastSummary = summary;
        lastSummaryKey = summaryKey;
        await onTargetScan(summary);
      }
      return target;
    },
    Boolean,
    15_000,
    `Chrome side panel did not open (${JSON.stringify(lastSummary ?? {})})`,
  );
  return {
    targetId: target.targetId,
    ...(await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })),
  };
}

export async function chooseChatInPanel(send, sessionId, chatId) {
  const rowSelector = `[data-chat-id="${chatId}"]`;
  await waitUntil(
    () => pageValue(send, sessionId, `Boolean(document.getElementById("chat-picker-trigger"))`),
    Boolean,
    10_000,
    "The side-panel Chat picker did not render",
  );
  await pageValue(send, sessionId, `document.getElementById("chat-picker-trigger").click(); true`);
  await waitUntil(
    () =>
      pageValue(
        send,
        sessionId,
        `(() => { const row=document.querySelector(${JSON.stringify(rowSelector)}); if(!row) return false; row.click(); return true; })()`,
      ),
    Boolean,
    10_000,
    "The side-panel Chat picker did not list the expected Chat",
  );
}

export async function openSplitFallback(send, sessionId) {
  await pageValue(send, sessionId, `document.getElementById("open-split").click(); true`);
  await waitUntil(
    () =>
      pageValue(send, sessionId, `document.getElementById("panel-status")?.textContent?.trim()`),
    (text) => text.includes("Chrome 155"),
    10_000,
    "Split View fallback status was not shown",
  );
  return pageValue(send, sessionId, `document.getElementById("panel-status").textContent.trim()`);
}

export async function watchPanelConnection(send, sessionId) {
  await pageValue(
    send,
    sessionId,
    `(() => { window.__slice8States=[]; const frame=document.getElementById("chat-frame"); const state=frame?.contentDocument?.getElementById("connection-state"); if (!state) throw new Error("panel Chat status is missing"); window.__slice8States.push(state.dataset.state); new MutationObserver(()=>window.__slice8States.push(state.dataset.state)).observe(state,{attributes:true,childList:true,subtree:true}); return true; })()`,
  );
}

export function stopDisposableSupervisor(executable) {
  const result = spawnSync(executable, ["--stop-supervisor"], {
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, "the disposable native supervisor did not stop cleanly");
}

export function panelToolEvidenceSummary() {
  return `(() => { const doc=globalThis.document.getElementById("chat-frame")?.contentDocument; const rows=[...(doc?.querySelectorAll(".activity-step")??[])]; rows.forEach((row)=>{row.closest(".activity-card")?.setAttribute("open","");row.closest(".activity-bundle")?.setAttribute("open","");row.open=true}); const results=rows.flatMap(row=>[...row.querySelectorAll(".step-detail,.structured-tool-result")].map(node=>node.textContent??"")); const text=results.join("\\n"); doc.querySelector(".tool-images")?.scrollIntoView({block:"center"}); return {imageStates:[...doc.querySelectorAll(".tool-images")].map(node=>node.textContent.trim().slice(0,160)),imageContainers:doc.querySelectorAll(".tool-images").length,imagePreviewReady:[...doc.querySelectorAll(".tool-images img")].some(img=>img.naturalWidth>0),stepCount:rows.length,resultCount:results.length,staleReference:text.includes("STALE_REF"),ambiguousTarget:text.includes("AMBIGUOUS_TARGET")}; })()`;
}
