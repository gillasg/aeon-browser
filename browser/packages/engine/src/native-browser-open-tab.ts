// Opening a tab: create it where the run wants it, record it, and wait for its first page.
import { engineConfig } from "./engine-config.js";
import { assertBrowserNetwork } from "./native-browser-dns.js";
import { guardPrivateTab } from "./native-browser-private-rules.js";
import type {
  BrowserExecutorRequest,
  BrowserExecutorResult,
  BrowserStep,
} from "@browserkit/protocol";
import { BrowserExecutorResultSchema } from "@browserkit/protocol";
import {
  withBrowserDebugger,
  assertRequestActive,
  bindBrowserSession,
} from "./native-browser-session.js";
import { claimAgentTab, groupAgentTab } from "./native-browser-groups.js";
import {
  agentOpenedTab,
  markAgentTabGrouped,
  trackAgentTab,
} from "./native-browser-tab-cleanup.js";
import { ownerTitle } from "./native-browser-owner.js";
import { enableQuietTab } from "./native-browser-quiet.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { BrowserActionError, assertOpenable, sameIdentity } from "./native-browser-common.js";
import { navigateReady } from "./native-browser-navigation.js";
import { navigationFailure } from "./native-browser-load-result.js";
import { settleOpenedTab } from "./native-browser-tab-replaced.js";
import { noteAgentNavigation, setAgentOpenedTab } from "./evidence/dialogs.js";
import { captureFromTabStart } from "./native-browser-network.js";
import { placementSpace } from "./native-browser-placement.js";
import { matchWindowViewport } from "./native-browser-window-viewport.js";
import type { BrowserIdentity } from "./native-worker-identity.js";
import { normalOrigins, originAllowed, setTabLocks } from "./native-browser-tab-locks.js";
import { mineTabIds } from "./native-browser-tab-cleanup.js";
import { chromeTabWindows, resolveTabWindow } from "./native-browser-tab-window.js";
import {
  ensureSpacesRestored,
  knownSpaceWindow,
  noteLabel,
  noteSpace,
  spaceWindow,
} from "./native-browser-spaces.js";

setAgentOpenedTab(agentOpenedTab);

export async function openTab(
  identity: BrowserIdentity,
  request: BrowserExecutorRequest,
): Promise<BrowserExecutorResult> {
  const step = validOpenTab(request, identity);
  await assertBrowserNetwork(step.url);
  const space =
    step.window || step.windowOf !== undefined
      ? "tabs"
      : await placementSpace(step, () => engineConfig.defaultSpace(request.chatId));
  await ensureSpacesRestored();
  const { tab: created, followed } = await createTab(step, request.chatId, space);
  if (created.id === undefined) throw new Error("TARGET_LOST");
  // A tab placed beside other tabs (windowOf, or following the chat's moved tabs) leaves the
  // chat's own window record as it was.
  if (!step.window && !followed)
    noteSpace(request.chatId, space, space === "window" ? created.windowId : undefined);
  trackAgentTab(created.id, request.chatId, { url: step.url });
  bindBrowserSession(created.id, request.chatId);
  markAgentTabGrouped(created.id);
  claimAgentTab(created.id);
  await lockOpenedTab(created.id, step);
  if (await engineConfig.privateNetwork())
    await guardPrivateTab(created.id, await engineConfig.privateNetworkPorts());
  await groupAgentTab(
    created.id,
    created.windowId,
    request.chatId,
    step.ownerTitle ?? ownerTitle(request.chatId),
  );
  if (step.quiet) await enableQuietTab(created.id, { ads: step.ads === true });
  const navigation = await navigateOpenedTab(
    created.id,
    step.url,
    step.timeoutMs,
    step.referer,
    step.window,
  );
  assertRequestActive(request);
  const { id, tab } = await settleOpenedTab(created.id, refreshInventoryTab);
  if (!tab || !sameIdentity(tab.target, identity)) throw new Error("TARGET_LOST");
  bindBrowserSession(id, request.chatId);
  if (id !== created.id) await lockOpenedTab(id, step);
  const label = noteLabel(request.chatId, id, tab.url);
  return BrowserExecutorResultSchema.parse({
    kind: "tab",
    tab: { ...tab, ...(label ? { label, control: "agent" as const } : {}) },
    ...(navigation ? { navigation: "failed" as const, reason: navigation } : {}),
  });
}

/**
 * Opens the tab's page, recording it from its first request. A page that will not load leaves a
 * tab behind: it belongs to this run, so it is reported (navigation: "failed", reason) rather
 * than thrown away as an untracked stray.
 */
async function navigateOpenedTab(
  tabId: number,
  url: string,
  timeoutMs?: number,
  referer?: string,
  window?: { width: number; height: number },
): Promise<string | undefined> {
  try {
    noteAgentNavigation(tabId);
    return await withBrowserDebugger(tabId, async () => {
      await captureFromTabStart(tabId);
      if (window) await matchWindowViewport(tabId, window).catch(() => undefined);
      return navigationFailure(await navigateReady(tabId, url, timeoutMs, referer));
    });
  } catch (error) {
    // The reason names Chrome's own error (net::ERR_CONNECTION_REFUSED…), not just our code.
    const detail = error instanceof BrowserActionError ? error.detail : undefined;
    return (detail ?? (error instanceof Error ? error.message : String(error))).slice(0, 400);
  }
}

// A window of its own is focused and normal-sized, so Chrome keeps painting it (screencasts and
// screenshots of a minimized or hidden window stall). Otherwise the tab opens where the chat's
// tabs are now (the user may have dragged them to another window), or beside step.windowOf.
async function createTab(
  step: Extract<BrowserStep, { op: "openTab" }>,
  chatId: string,
  space: "window" | "tabs",
): Promise<{ tab: chrome.tabs.Tab; followed: boolean }> {
  if (step.window) return { tab: await createWindowTab(step.window), followed: false };
  const follow = await resolveTabWindow(chromeTabWindows, {
    ...(step.windowOf !== undefined ? { windowOf: step.windowOf } : {}),
    ownTabs: mineTabIds(chatId),
  });
  const spaceWindowId = space === "window" ? knownSpaceWindow(chatId) : undefined;
  if (space === "window" && (follow === undefined || follow === spaceWindowId))
    return { tab: await createSpaceTab(chatId), followed: false };
  // A background tab never takes the user's active tab, whatever the front setting says.
  const front =
    !step.background && (step.foreground || (await engineConfig.agentInFront().catch(() => false)));
  const tab = await chrome.tabs.create({
    url: "about:blank",
    active: space === "tabs" && front,
    ...(follow !== undefined ? { windowId: follow } : {}),
  });
  return { tab, followed: step.windowOf !== undefined || space === "window" };
}

async function createSpaceTab(chatId: string): Promise<chrome.tabs.Tab> {
  const window = await spaceWindow(chatId);
  // The new window's first tab becomes the agent tab: active inside its unfocused window,
  // so Chrome keeps painting it and every later tab starts from a real page, not a stray blank.
  if (window.freshTabId !== undefined) {
    await chrome.tabs.update(window.freshTabId, { active: true });
    const tab = await chrome.tabs.get(window.freshTabId).catch(() => undefined);
    if (!tab) throw new Error("TARGET_LOST");
    return tab;
  }
  return chrome.tabs.create({ url: "about:blank", active: true, windowId: window.windowId });
}

async function createWindowTab(size: { width: number; height: number }): Promise<chrome.tabs.Tab> {
  const window = await chrome.windows.create({
    url: "about:blank",
    focused: true,
    type: "normal",
    width: size.width,
    height: size.height,
  });
  const tab = window?.tabs?.[0];
  if (!tab) throw new Error("TARGET_LOST");
  return tab;
}

async function lockOpenedTab(
  tabId: number,
  step: Extract<BrowserStep, { op: "openTab" }>,
): Promise<void> {
  await setTabLocks(tabId, {
    ...(step.readOnly ? { readOnly: true } : {}),
    ...(step.allowedOrigins ? { allowedOrigins: step.allowedOrigins } : {}),
  });
}

function validOpenTab(
  request: BrowserExecutorRequest,
  identity: BrowserIdentity,
): Extract<BrowserStep, { op: "openTab" }> {
  if (request.step.op !== "openTab" || request.step.clientInstanceId !== identity.clientInstanceId)
    throw new Error("INVALID_TARGET");
  assertOpenable(request.step.url);
  if (request.step.allowedOrigins) {
    const origins = normalOrigins(request.step.allowedOrigins);
    if (!originAllowed(request.step.url, origins))
      throw new Error(
        `TAB_ORIGIN_BLOCKED: ${request.step.url} is not on the allowedOrigins it lists`,
      );
  }
  return request.step;
}
