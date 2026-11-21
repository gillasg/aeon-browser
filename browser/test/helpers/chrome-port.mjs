import { readFile } from "node:fs/promises";
import { join } from "node:path";

const intervalMs = 100;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Cold macOS runners can take longer than the old 15s test waits to write this file.
export async function chromePort(profile, { timeout = 60000 } = {}) {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + timeout;
  for (;;) {
    const port = await parsePort(file);
    if (port !== undefined) return port;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`DevToolsActivePort never appeared after ${timeout}ms`);
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

// A half-written file parses as NaN or 0. Keep polling until the first line is a real port.
async function parsePort(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const port = Number(text.split("\n")[0]);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  return port;
}
