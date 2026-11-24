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
const onEvent = event();
globalThis.chrome = {
  // A gate-pending page: the renderer never answers probes, one request never resolves.
  debugger: { sendCommand: () => new Promise(() => {}), onEvent, onDetach: event() },
  tabs: {
    get: async () => ({ url: "https://gate.test/" }),
    onRemoved: event(),
    onUpdated: event(),
  },
  runtime: { onInstalled: event(), onStartup: event(), id: "x" },
};

const nav = await import("../dist/native-browser-navigation.js");
const { installEngineListeners } = await import("../dist/native-engine-install.js");
try {
  installEngineListeners();
} catch {
  // Listeners for APIs this stub lacks may fail; the navigation ones are installed.
}

test("wait-for-idle ends at the deadline with what is still loading, never a bare TIMEOUT", async () => {
  nav.trackBrowserActivity(9);
  onEvent.fire({ tabId: 9 }, "Network.requestWillBeSent", {
    requestId: "r1",
    type: "Fetch",
    request: { url: "https://gate.test/never" },
  });
  const started = Date.now();
  const result = await nav.waitForIdleUntil(9, started + 1000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 1200, `bounded: took ${elapsed} ms`);
  assert.equal(result.idle, false);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].url, "https://gate.test/never");
  assert.ok(result.pending[0].ageMs >= 900);
  assert.equal(result.note, "Still loading: 1 request pending; the page is usable");
});

test("a deadline already past resolves at once", async () => {
  const started = Date.now();
  const result = await nav.waitForIdleUntil(10, started - 1);
  assert.ok(Date.now() - started < 50);
  assert.equal(result.idle, false);
  assert.match(result.note, /Still loading: 0 requests pending/);
});
