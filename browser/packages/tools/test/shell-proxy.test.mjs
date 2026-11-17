import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { shellProxyEnv } from "../dist/shell-proxy.js";

const run = promisify(execFile);
const SECRET = "hidden-page-body";

function listen(host, onRequest) {
  const server = createServer(onRequest);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

test("curl cannot read a blocked site, or follow a redirect into one", async () => {
  const home = await mkdtemp(join(tmpdir(), "shell-gate-"));
  const previous = process.env.BROWSERKIT_HOME;
  let hits = 0;
  // The blocked site is named "localhost" so the test runs on macOS too (only 127.0.0.1 exists there).
  const blocked = await listen("127.0.0.1", (_request, response) => {
    hits += 1;
    response.end(SECRET);
  });
  const open = await listen("127.0.0.1", (request, response) => {
    if (request.url === "/go") {
      response.writeHead(302, {
        Location: `http://localhost:${blocked.port}/secret`,
      });
      response.end();
      return;
    }
    response.end("open-page");
  });
  process.env.BROWSERKIT_HOME = home;
  await writeFile(join(home, "site-rules.json"), JSON.stringify({ blocked: ["localhost"] }) + "\n");
  const env = { ...process.env, ...(await shellProxyEnv()) };
  const curl = (url) =>
    run("curl", ["-sS", "-L", "--max-time", "5", url], { env }).then(
      (result) => result.stdout,
      (error) => `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
  try {
    const direct = await curl(`http://localhost:${blocked.port}/secret`);
    const hopped = await curl(`http://127.0.0.1:${open.port}/go`);
    const allowed = await curl(`http://127.0.0.1:${open.port}/ok`);
    assert.match(direct, /SITE_BLOCKED/);
    assert.match(hopped, /SITE_BLOCKED/);
    assert.equal(direct.includes(SECRET), false);
    assert.equal(hopped.includes(SECRET), false);
    assert.equal(hits, 0);
    assert.match(allowed, /open-page/);
  } finally {
    if (previous === undefined) delete process.env.BROWSERKIT_HOME;
    else process.env.BROWSERKIT_HOME = previous;
    blocked.server.close();
    open.server.close();
  }
});
