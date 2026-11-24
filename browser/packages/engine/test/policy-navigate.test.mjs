import assert from "node:assert/strict";
import test from "node:test";

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    fire: (...args) => [...listeners].forEach((fn) => fn(...args)),
  };
}
const nav = {
  onCommitted: event(),
  onDOMContentLoaded: event(),
  onErrorOccurred: event(),
  onHistoryStateUpdated: event(),
  onReferenceFragmentUpdated: event(),
};
globalThis.chrome = {
  debugger: { sendCommand: async () => ({}), onEvent: event(), onDetach: event() },
  tabs: {
    get: async () => ({ url: "about:blank" }),
    update: async (tabId, { url }) => {
      // A redirect hop to a blocked host: Chrome refuses it at once.
      queueMicrotask(() =>
        nav.onErrorOccurred.fire({
          tabId,
          frameId: 0,
          url: url.replace("start", "blocked"),
          error: "net::ERR_BLOCKED_BY_CLIENT",
        }),
      );
      return {};
    },
    onRemoved: event(),
    onUpdated: event(),
  },
  webNavigation: nav,
  runtime: { onInstalled: event(), onStartup: event(), id: "x" },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const { navigateReady, policyBlockedError } = await import("../dist/native-browser-navigation.js");

test("a blocked navigation or redirect hop rejects with POLICY_BLOCKED well under 100 ms", async () => {
  const started = Date.now();
  await assert.rejects(navigateReady(5, "https://start.example.test/", 30_000), (error) => {
    assert.equal(error.message, "POLICY_BLOCKED");
    assert.match(error.detail, /blocked\.example\.test is blocked by a site rule/);
    assert.match(error.detail, /Settings → Sites/);
    return true;
  });
  assert.ok(Date.now() - started < 100, "must not wait out the navigate timeout");
});

test("only policy errors map to POLICY_BLOCKED", () => {
  assert.equal(policyBlockedError("net::ERR_NAME_NOT_RESOLVED", "https://a.test/"), undefined);
  assert.equal(
    policyBlockedError("net::ERR_BLOCKED_BY_ADMINISTRATOR", "https://a.test/x").detail,
    "a.test is blocked by an administrator policy; allow it in Settings → Sites",
  );
});
