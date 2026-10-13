import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openModelLogin } from "../dist/model-login.js";

test("Connect a model opens one sign-in page and reuses it", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "aeon-pi-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const url = await openModelLogin(agentDir, () => undefined);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  assert.equal(await openModelLogin(agentDir, () => undefined), url);
  const page = await fetch(url.replace(/#.*/, ""));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Connect an AI model/);
  const token = new URL(url).hash.slice("#token=".length);
  const done = await fetch(new URL("/api/done", url), {
    method: "POST",
    headers: { "x-pi-ai-login-token": token },
  });
  assert.equal(done.status, 200);
});
