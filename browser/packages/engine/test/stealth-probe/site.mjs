// Local loopback fixture server for the hermetic real-Chrome stealth probe.
// Serves a self-contained HTML page and script that measure real CDP/automation tells
// (navigator.webdriver, Error.stack serialization trap, trusted input, globals, DOM tells).
import { createServer } from "node:http";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const PROBE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Graft Stealth Probe</title>
  </head>
  <body>
    <main>
      <h1>Stealth Probe</h1>
      <button id="target-btn" type="button">Press target</button>
      <input id="target-input" type="text" placeholder="Type here" />
      <p id="status">idle</p>
      <img src="/pixel.png" width="1" height="1" alt="" />
    </main>
    <script src="/snapshot.js"></script>
  </body>
</html>
`;

const SNAPSHOT_JS = `(() => {
  const events = { clicks: [], keys: [], inputs: [] };
  const btn = document.getElementById("target-btn");
  const input = document.getElementById("target-input");
  const status = document.getElementById("status");

  btn.addEventListener("click", (ev) => {
    events.clicks.push({
      isTrusted: ev.isTrusted,
      clientX: ev.clientX,
      clientY: ev.clientY,
      detail: ev.detail,
    });
    status.textContent = "clicked";
  });
  input.addEventListener("keydown", (ev) => {
    events.keys.push({ isTrusted: ev.isTrusted, key: ev.key });
  });
  input.addEventListener("input", (ev) => {
    events.inputs.push({ isTrusted: ev.isTrusted, value: input.value });
  });

  function detectCdpGlobals() {
    const patterns = [
      /^cdc_/,
      /^__webdriver/,
      /^__driver_/,
      /^__selenium/,
      /^_Selenium/,
      /^callSelenium/,
      /^__pw/,
      /^__playwright/,
      /^__puppeteer/,
      /^__graft/,
    ];
    const hits = [];
    for (const key of Object.getOwnPropertyNames(window)) {
      if (patterns.some((re) => re.test(key))) hits.push("window." + key);
    }
    for (const key of Object.getOwnPropertyNames(document)) {
      if (patterns.some((re) => re.test(key))) hits.push("document." + key);
    }
    return hits.sort();
  }

  function detectRuntimeEnableTrap() {
    let stackGetterCalled = false;
    const probeError = new Error("stealth-probe-check");
    Object.defineProperty(probeError, "stack", {
      configurable: true,
      get() {
        stackGetterCalled = true;
        return "Error: stealth-probe-check";
      },
    });
    console.debug(probeError);
    return stackGetterCalled;
  }

  function detectStackLeak() {
    const stack = String(new Error().stack || "");
    const markers = ["chrome-extension://", "pptr://", "UtilityScript", "__puppeteer"];
    return markers.filter((m) => stack.includes(m));
  }

  function detectDomExpandos() {
    const hits = [];
    const nodes = document.querySelectorAll("*");
    for (const el of nodes) {
      for (const key of Object.getOwnPropertyNames(el)) {
        if (/^(__graft|__webdriver|__cdp|cdc_)/.test(key)) hits.push(el.tagName + "." + key);
      }
      if (el.tagName === "IFRAME" && String(el.src || "").startsWith("chrome-extension://")) {
        hits.push("iframe:" + el.src);
      }
    }
    return hits.sort();
  }

  window.__probeSnapshot = async () => {
    const runtimeEnableTrap = detectRuntimeEnableTrap();
    let permissionsOk = false;
    try {
      const perm = await navigator.permissions.query({ name: "notifications" });
      permissionsOk = typeof perm.state === "string";
    } catch {
      permissionsOk = false;
    }
    return {
      webdriver: Boolean(navigator.webdriver),
      chromeRuntimeIdExposed: typeof window.chrome?.runtime?.id === "string",
      cdpGlobals: detectCdpGlobals(),
      runtimeEnableTrap,
      stackLeakMarkers: detectStackLeak(),
      domExpandos: detectDomExpandos(),
      languagesCount: Array.isArray(navigator.languages) ? navigator.languages.length : 0,
      permissionsOk,
      clickCount: events.clicks.length,
      allClicksTrusted: events.clicks.length > 0 && events.clicks.every((c) => c.isTrusted),
      clicksHaveCoords:
        events.clicks.length > 0 && events.clicks.every((c) => c.clientX > 0 && c.clientY > 0),
      inputValue: input.value,
      allInputsTrusted: events.inputs.length > 0 && events.inputs.every((i) => i.isTrusted),
    };
  };
})();
`;

export async function startProbeServer() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/snapshot.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(SNAPSHOT_JS);
      return;
    }
    if (path === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PIXEL_PNG);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PROBE_HTML);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
