import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostHandler } from "../dist/host.js";

test("siteNotes on loopback URLs are isolated by host:port", async () => {
  const home = await mkdtemp(join(tmpdir(), "graft-loopback-"));
  const prev = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = home;
  const handle = createHostHandler({ dataDirectory: home });
  try {
    await handle(
      {
        siteNotes: {
          site: "http://127.0.0.1:41234/shop",
          kind: "quirk",
          key: "fixture",
          value: "lampStock eval fixture only",
        },
      },
      {},
    );
    const otherPort = await handle({ siteNotes: "http://127.0.0.1:3773/settings" }, {});
    const samePort = await handle({ siteNotes: "http://127.0.0.1:41234/cart" }, {});
    assert.equal(String(otherPort || "").includes("lampStock"), false);
    assert.match(String(samePort || ""), /lampStock/);
  } finally {
    if (prev === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
