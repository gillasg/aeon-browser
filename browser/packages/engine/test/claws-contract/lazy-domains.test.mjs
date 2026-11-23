// Layer 1 contract: lazy-load and zero idle overhead. DOM and Accessibility enable at the first
// call that needs them, once per tab, and never for a page that only sits there. The debugger is
// stubbed so the count of Domain.enable commands is the whole observable behaviour.
import assert from "node:assert/strict";
import test from "node:test";
import { beginLazyDomain, forgetDomains, setDomainFailureNote } from "../../dist/cdp/domains.js";

function installDebugger({ failFirst = false } = {}) {
  const sent = [];
  let failures = failFirst ? 1 : 0;
  globalThis.chrome = {
    debugger: {
      sendCommand: async (debuggee, method) => {
        sent.push({ tabId: debuggee.tabId, method });
        await Promise.resolve();
        if (method.endsWith(".enable") && failures > 0) {
          failures -= 1;
          throw new Error("enable refused");
        }
        return {};
      },
    },
  };
  return sent;
}

const enables = (sent) => sent.filter((call) => call.method.endsWith(".enable"));
const debuggee = (tabId) => ({ tabId });

test("attaching to a page with no calls sends no domain enable (zero idle overhead)", () => {
  const sent = installDebugger();
  assert.equal(sent.length, 0);
  assert.equal(enables(sent).length, 0);
});

test("domains outside the lazy set never start an enable", () => {
  const sent = installDebugger();
  for (const method of ["Page.navigate", "Runtime.evaluate", "Network.getResponseBody"])
    assert.equal(beginLazyDomain(debuggee(101), method), undefined, method);
  assert.equal(sent.length, 0);
});

test("the first DOM call enables DOM once; later calls on the same tab cost nothing", async () => {
  const sent = installDebugger();
  const tab = 102;
  const first = beginLazyDomain(debuggee(tab), "DOM.getDocument");
  assert.ok(first instanceof Promise, "first DOM call waits for the enable");
  await first;
  assert.deepEqual(enables(sent), [{ tabId: tab, method: "DOM.enable" }]);
  assert.equal(beginLazyDomain(debuggee(tab), "DOM.querySelector"), undefined);
  assert.equal(enables(sent).length, 1, "a marked domain is not enabled again");
  forgetDomains(tab);
});

test("concurrent callers share one in-flight enable", async () => {
  const sent = installDebugger();
  const tab = 103;
  const a = beginLazyDomain(debuggee(tab), "Accessibility.getFullAXTree");
  const b = beginLazyDomain(debuggee(tab), "Accessibility.queryAXTree");
  assert.equal(a, b, "the second caller receives the same promise");
  await a;
  assert.equal(enables(sent).length, 1);
  forgetDomains(tab);
});

test("an explicit .enable is left to the caller and starts nothing", () => {
  const sent = installDebugger();
  assert.equal(beginLazyDomain(debuggee(104), "DOM.enable"), undefined);
  assert.equal(sent.length, 0);
});

test("a failed enable is reported and left unmarked, so the next call retries", async () => {
  const sent = installDebugger({ failFirst: true });
  const notes = [];
  setDomainFailureNote((label) => notes.push(label));
  const tab = 105;
  await beginLazyDomain(debuggee(tab), "DOM.getDocument");
  assert.deepEqual(notes, ["DOM.enable"]);
  await beginLazyDomain(debuggee(tab), "DOM.getDocument");
  assert.equal(enables(sent).length, 2, "the failed domain was not marked");
  assert.deepEqual(notes, ["DOM.enable"], "the retry succeeded and reported nothing");
  forgetDomains(tab);
});

test("forgetting a tab makes its domains enable again, and only that tab", async () => {
  const sent = installDebugger();
  await beginLazyDomain(debuggee(106), "DOM.getDocument");
  await beginLazyDomain(debuggee(107), "DOM.getDocument");
  forgetDomains(106);
  await beginLazyDomain(debuggee(106), "DOM.getDocument");
  await beginLazyDomain(debuggee(107), "DOM.getDocument");
  const byTab = (tab) => enables(sent).filter((call) => call.tabId === tab).length;
  assert.equal(byTab(106), 2);
  assert.equal(byTab(107), 1);
  forgetDomains(106);
  forgetDomains(107);
});

test("a debuggee without a tab id has nothing to enable", () => {
  const sent = installDebugger();
  assert.equal(beginLazyDomain({}, "DOM.getDocument"), undefined);
  assert.equal(sent.length, 0);
});
