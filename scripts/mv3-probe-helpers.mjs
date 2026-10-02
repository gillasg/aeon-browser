import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readGrant(child) {
  return new Promise((resolveGrant, rejectGrant) => {
    const timeout = setTimeout(
      () => rejectGrant(new Error("Timed out waiting for the dev daemon grant.")),
      10000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const grant = String(chunk).match(/Pippin development grant: ([A-Za-z0-9_-]{43})/)?.[1];
      if (!grant) return;
      clearTimeout(timeout);
      resolveGrant(grant);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectGrant(error);
    });
    child.once("exit", (code) => {
      if (code === 0) return;
      clearTimeout(timeout);
      rejectGrant(new Error(`The dev daemon exited before issuing a grant (code ${code}).`));
    });
  });
}

export async function waitForDebugPort(profilePath) {
  const path = join(profilePath, "DevToolsActivePort");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const port = (await readFile(path, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port)) return port;
    } catch {
      // Chrome creates this file after the browser process starts.
    }
    await delay(100);
  }
  throw new Error("Isolated Chrome did not expose its local debugging endpoint.");
}

export function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const failPending = () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("Chrome remote debugging disconnected."));
    pending.clear();
  };

  socket.addEventListener("close", failPending, { once: true });
  socket.addEventListener("error", failPending);
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(String(event.data));
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) waiter.reject(new Error(response.error.message));
    else waiter.resolve(response.result);
  });
  return new Promise((resolveConnection, rejectConnection) => {
    socket.addEventListener(
      "open",
      () => resolveConnection({ socket, send: makeSender(socket, pending, () => ++nextId) }),
      { once: true },
    );
    socket.addEventListener("error", rejectConnection, { once: true });
  });
}

function makeSender(socket, pending, nextId) {
  return (method, params = {}, sessionId) => {
    if (socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Chrome remote debugging is unavailable."));
    const id = nextId();
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolveResult, rejectResult) =>
      pending.set(id, { resolve: resolveResult, reject: rejectResult }),
    );
  };
}

export async function waitForExtension(send) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { targetInfos } = await send("Target.getTargets");
    const worker = targetInfos.find(
      (target) => target.type === "service_worker" && target.url.endsWith("/service-worker.js"),
    );
    const extensionId = worker?.url.match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1];
    if (extensionId) return extensionId;
    await delay(200);
  }
  throw new Error("Chrome for Testing did not register the MV3 service worker.");
}

export async function openOptionsPage(send, extensionId) {
  const { targetId } = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/options.html`,
  });
  await delay(300);
  return send("Target.attachToTarget", { targetId, flatten: true });
}

export async function connectHarness(send, sessionId, grant) {
  const expression = `document.getElementById("grant").value = ${JSON.stringify(grant)}; document.getElementById("connect-form").requestSubmit(); "submitted"`;
  await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = await evaluate(send, sessionId);
    if (status.ui.startsWith("Connected") && status.executor.startsWith("Connected")) return status;
    await delay(200);
  }
  const status = await evaluate(send, sessionId);
  throw new Error(
    `Both extension hello acknowledgements were not observed: ${JSON.stringify(status)}`,
  );
}

async function evaluate(send, sessionId) {
  const expression = `JSON.stringify({ui: document.getElementById("ui-status")?.textContent ?? "", executor: document.getElementById("executor-status")?.textContent ?? ""})`;
  const result = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  return JSON.parse(result.result.value);
}

export function parseAckStatus(role, status) {
  const id = status.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  if (!id) throw new Error(`Missing ${role} hello connection ID in extension status: ${status}`);
  if (role === "ui" && !status.includes("protocol 1.1")) {
    throw new Error(`The UI did not report the typed protocol version: ${status}`);
  }
  if (role === "extension-executor" && !status.includes("protocol 1.1")) {
    throw new Error(`The worker did not report the typed protocol version: ${status}`);
  }
  return { kind: "hello.ack", protocolVersion: { major: 1, minor: 1 }, role, connectionId: id };
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(5000)]);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
