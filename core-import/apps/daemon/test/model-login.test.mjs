import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openModelLogin } from "../dist/model-login.js";

test("the Models page service starts once, answers its API with the token, and serves no page", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "aeon-pi-"));
  const url = await openModelLogin(agentDir, () => undefined);
  const token = new URL(url).hash.slice("#token=".length);
  const api = (path, init = {}) =>
    fetch(new URL(path, url), {
      ...init,
      headers: { "x-aeon-login-token": token, ...(init.headers ?? {}) },
    });
  t.after(async () => {
    await api("/api/done", { method: "POST" }).catch(() => undefined);
    rmSync(agentDir, { recursive: true, force: true });
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  assert.equal(await openModelLogin(agentDir, () => undefined), url);

  assert.equal((await fetch(url.replace(/#.*/, ""))).status, 404, "no sign-in page any more");
  assert.equal((await fetch(new URL("/api/state", url))).status, 401, "the token is required");
  const state = await api("/api/state");
  assert.equal(state.status, 200);
  assert.ok(Array.isArray((await state.json()).providers));

  const fromSite = await api("/api/state", { headers: { origin: "https://example.com" } });
  assert.equal(fromSite.status, 403, "web pages are refused");
  const fromExtension = await api("/api/state", {
    headers: { origin: "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh" },
  });
  assert.equal(
    fromExtension.headers.get("access-control-allow-origin"),
    "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh",
  );
});
