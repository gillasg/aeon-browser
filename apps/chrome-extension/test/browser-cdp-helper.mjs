import { readFile } from "node:fs/promises";
import { join } from "node:path";
export async function waitForDebugPort(profilePath) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const port = (await readFile(join(profilePath, "DevToolsActivePort"), "utf8")).split(
        /\r?\n/,
      )[0];
      if (/^\d+$/.test(port)) return port;
    } catch {
      /* Chrome writes its debugging port after startup. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("Isolated Chrome did not expose its debugging endpoint");
}
export function connectCdp(url) {
  const socket = new WebSocket(url),
    pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(String(event.data)),
      waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) waiter.reject(Error(response.error.message));
    else waiter.resolve(response.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(Error("Isolated Chrome disconnected"));
    pending.clear();
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "open",
      () =>
        resolve({
          socket,
          send(method, params = {}) {
            const id = ++nextId;
            return new Promise((done, fail) => {
              pending.set(id, { resolve: done, reject: fail });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        }),
      { once: true },
    );
    socket.addEventListener("error", reject, { once: true });
  });
}
export async function stopChild(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
}
