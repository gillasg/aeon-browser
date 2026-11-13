import { onEngineInstall } from "./native-engine-install.js";
import { noteInjectedScript } from "./stealth.js";
import { nativeSourcePreamble } from "./native-source.js";
import { send } from "./cdp/send.js";
import { onBrowserDebuggerAttached } from "./native-browser-session.js";

// Quiet tabs are for unattended reading (explore, jobs, crawls): no popunders in front of the
// user, no autoplaying audio, and the common ad/tracker hosts blocked before they load. The
// rules are per-tab and live in the engine's own DNR range; closing the tab releases them.
const RULE_BASE = 600_000;
const RULE_SPAN = 90_000;
const quiet = new Set<number>();
const adsOn = new Set<number>();
const loaderIds = new Map<number, string>();
const ruleIds = new Map<number, number[]>();
let nextRule = 0;

const AD_HOSTS = [
  "2mdn.net",
  "adnxs.com",
  "adsrvr.org",
  "amazon-adsystem.com",
  "amplitude.com",
  "bidswitch.net",
  "bluekai.com",
  "casalemedia.com",
  "clarity.ms",
  "connect.facebook.net",
  "criteo.com",
  "demdex.net",
  "doubleclick.net",
  "everesttech.net",
  "facebook.net",
  "fullstory.com",
  "google-analytics.com",
  "googleadservices.com",
  "googlesyndication.com",
  "googletagmanager.com",
  "hotjar.com",
  "media.net",
  "mixpanel.com",
  "moatads.com",
  "openx.net",
  "outbrain.com",
  "pubmatic.com",
  "quantserve.com",
  "rubiconproject.com",
  "scorecardresearch.com",
  "segment.io",
  "sharethrough.com",
  "smartadserver.com",
  "spotxchange.com",
  "taboola.com",
  "teads.tv",
  "yieldmo.com",
  "zedo.com",
];
const ALL_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "image",
  "media",
  "font",
  "stylesheet",
  "websocket",
  "ping",
  "csp_report",
  "object",
  "webtransport",
  "webbundle",
  "other",
] as chrome.declarativeNetRequest.ResourceType[];

// Hooks play() and mutes what is already in the document. A one-shot sweep is not enough: it runs
// on the blank tab, then the real page calls play() after navigation.
const MEDIA_BODY = `
  const realPlay = HTMLMediaElement.prototype.play;
  const play = function () {
    try { this.autoplay = false; this.muted = true; this.pause(); } catch {}
    return Promise.resolve();
  };
  __keepNative(play, realPlay);
  HTMLMediaElement.prototype.play = play;
  const quiet = () => {
    for (const media of document.querySelectorAll('video,audio')) {
      try { media.autoplay = false; media.muted = true; media.pause(); } catch {}
    }
  };
  const watch = () => {
    quiet();
    new MutationObserver(quiet).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) watch();
  else document.addEventListener('DOMContentLoaded', watch, { once: true });
  quiet();
`;

const MEDIA_SCRIPT = `(() => {
  ${nativeSourcePreamble}
  ${MEDIA_BODY}
})();`;

const QUIET_SCRIPT = `(() => {
  ${nativeSourcePreamble}
  const realOpen = window.open;
  const open = function () { return null; };
  __keepNative(open, realOpen);
  window.open = open;
  ${MEDIA_BODY}
})();`;

const QUIET_SWEEP = `(() => {
  for (const media of document.querySelectorAll('video,audio')) {
    try { media.autoplay = false; media.muted = true; media.pause(); } catch {}
  }
})()`;

/** Quiet mutes media on this document and the next one. Ad-host blocking and the window.open hook stay off unless `ads` (explore, crawl). */
export async function enableQuietTab(
  tabId: number,
  options: { ads?: boolean } = {},
): Promise<void> {
  if (options.ads) adsOn.add(tabId);
  if (!quiet.has(tabId)) {
    quiet.add(tabId);
    noteInjectedScript(
      tabId,
      options.ads ? "quiet tab: media muted, ads filtered" : "quiet tab: media muted",
      "main",
    );
  }
  if (options.ads) await addRules(tabId);
}

export async function disableQuietTab(tabId: number): Promise<void> {
  quiet.delete(tabId);
  adsOn.delete(tabId);
  loaderIds.delete(tabId);
  const ids = ruleIds.get(tabId) ?? [];
  ruleIds.delete(tabId);
  if (ids.length)
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: ids })
      .catch(() => undefined);
}

export function isQuietTab(tabId: number): boolean {
  return quiet.has(tabId);
}

async function addRules(tabId: number): Promise<void> {
  if (ruleIds.has(tabId)) return;
  const ids = [RULE_BASE + (nextRule++ % RULE_SPAN)];
  ruleIds.set(tabId, ids);
  await chrome.declarativeNetRequest
    .updateSessionRules({
      addRules: [
        {
          id: ids[0] as number,
          priority: 2,
          action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
          condition: {
            requestDomains: AD_HOSTS,
            resourceTypes: ALL_TYPES,
            tabIds: [tabId],
          },
        },
      ],
    })
    .catch(() => undefined);
}

function documentScript(tabId: number): string {
  return adsOn.has(tabId) ? QUIET_SCRIPT : MEDIA_SCRIPT;
}

async function installQuietScript(tabId: number): Promise<void> {
  await send(
    { tabId },
    "Page.addScriptToEvaluateOnNewDocument",
    { source: documentScript(tabId) },
    { label: "onQuietAttach" },
  ).catch(() => undefined);
}

function quietSource(tabId: number, loader: string | undefined): string {
  // Same document already ran the hook. A second eval would wrap play() again.
  return loader && loaderIds.get(tabId) === loader ? QUIET_SWEEP : documentScript(tabId);
}

async function onQuietAttach(tabId: number): Promise<void> {
  await installQuietScript(tabId);
  const tree = (await send({ tabId }, "Page.getFrameTree", {}, { label: "onQuietAttach" }).catch(
    () => undefined,
  )) as { frameTree?: { frame?: { loaderId?: string } } } | undefined;
  const loader = tree?.frameTree?.frame?.loaderId;
  const expression = quietSource(tabId, loader);
  if (loader) loaderIds.set(tabId, loader);
  await send(
    { tabId },
    "Runtime.evaluate",
    { expression, awaitPromise: false },
    { label: "onQuietAttach", ms: 5_000 },
  ).catch(() => undefined);
}

onEngineInstall(() => {
  onBrowserDebuggerAttached((tabId) => {
    if (quiet.has(tabId)) return onQuietAttach(tabId);
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || !quiet.has(source.tabId)) return;
    if (method !== "Page.frameNavigated") return;
    const frame = (params as { frame?: { loaderId?: string; parentId?: string } }).frame;
    if (frame?.loaderId && !frame.parentId) loaderIds.set(source.tabId, frame.loaderId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    quiet.delete(tabId);
    adsOn.delete(tabId);
    loaderIds.delete(tabId);
    const ids = ruleIds.get(tabId) ?? [];
    ruleIds.delete(tabId);
    if (ids.length)
      void chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: ids })
        .catch(() => undefined);
  });
});
