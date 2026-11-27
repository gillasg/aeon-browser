// Graft's own pages (home, chat) are drivable and openable like any tab, and listed as Graft UI. Chrome's
// pages and other extensions' pages are refused with PROTECTED_UI, never retried.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserStepSchema } from "@browserkit/protocol";

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const CLIENT = "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8";
const RUN = "7c2f4b1e-0d5a-4e8b-9a61-3f2b8c9d0e14";
globalThis.chrome = { runtime: { id: OWN } };
const common = await import("../dist/native-browser-common.js");
const dns = await import("../dist/native-browser-dns.js");
const { configureEngine } = await import("../dist/engine-config.js");
const { toInventoryTab } = await import("../dist/native-inventory-client.js");

const OWN_PAGES = [
  `chrome-extension://${OWN}/chat.html?chatId=1`,
  `chrome-extension://${OWN}/home.html`,
];
const WEB = ["https://example.com/", "http://example.com/"];

test("Graft's own pages are drivable; about:blank, Chrome's and other extensions' pages are not", () => {
  for (const url of [...OWN_PAGES, ...WEB]) assert.equal(common.drivablePage(url), true, url);
  assert.equal(common.graftUiPage(`chrome-extension://${OTHER}/home.html`), false);
  for (const url of [
    "about:blank",
    "chrome://settings",
    `chrome-extension://${OTHER}/popup.html`,
    "file:///etc/hosts",
  ])
    assert.equal(common.drivablePage(url), false, url);
});

test("opening a Chrome or other-extension page is PROTECTED_UI; a script URL is INVALID_TARGET", () => {
  for (const url of ["chrome://settings", `chrome-extension://${OTHER}/popup.html`]) {
    assert.throws(
      () => common.assertOpenable(url),
      (error) =>
        /^PROTECTED_UI: /.test(error.message) && common.errorCode(error) === "PROTECTED_UI",
      url,
    );
  }
  assert.throws(
    () => common.assertOpenable("javascript:alert(1)"),
    (error) => error.message === "INVALID_TARGET",
  );
  for (const url of [...OWN_PAGES, ...WEB])
    assert.doesNotThrow(() => common.assertOpenable(url), url);
});

test("the protocol takes Graft's pages and about:blank; Chrome's pages reach the engine's refusal", () => {
  const target = { clientInstanceId: CLIENT, browserRunId: RUN, tabId: 9, tabIncarnation: RUN };
  for (const url of [...OWN_PAGES, "about:blank", "chrome://settings"]) {
    const open = BrowserStepSchema.safeParse({ op: "openTab", clientInstanceId: CLIENT, url });
    const navigate = BrowserStepSchema.safeParse({ op: "navigate", target, url });
    assert.equal(open.success, true, `openTab ${url}`);
    assert.equal(navigate.success, true, `navigate ${url}`);
  }
  const script = { op: "openTab", clientInstanceId: CLIENT, url: "javascript:alert(1)" };
  assert.equal(BrowserStepSchema.safeParse(script).success, false);
});

test("the inventory marks Graft's own pages, and only those", () => {
  const identity = { clientInstanceId: CLIENT, browserRunId: RUN };
  const state = { tabIncarnation: RUN, documentEpoch: 0 };
  const tab = {
    windowId: 1,
    index: 0,
    title: "Chat",
    status: "complete",
    active: true,
    pinned: false,
    groupId: -1,
  };
  const own = toInventoryTab({ ...tab, id: 9, url: OWN_PAGES[0] }, identity, state);
  const web = toInventoryTab({ ...tab, id: 10, url: WEB[0] }, identity, state);
  assert.equal(own.graftUi, true);
  assert.equal("graftUi" in web, false);
});

test("a private-network check does not look up Graft's own pages or about:blank as hosts", async () => {
  configureEngine({ privateNetwork: async () => true, privateNetworkPorts: async () => [] });
  await assert.doesNotReject(dns.assertBrowserNetwork(OWN_PAGES[0]));
  await assert.doesNotReject(dns.assertBrowserNetwork("about:blank"));
});

test("exactly about:blank opens; other about: and file: URLs stay refused", () => {
  assert.doesNotThrow(() => common.assertOpenable("about:blank"));
  for (const url of ["about:blank#x", "about:srcdoc", "about:version", "file:///etc/hosts"])
    assert.throws(() => common.assertOpenable(url), /INVALID_TARGET|PROTECTED_UI/, url);
});
