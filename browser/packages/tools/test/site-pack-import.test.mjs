import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

// fflate is site-mapper's dependency: resolve it from there.
const { zipSync, strToU8 } = createRequire(import.meta.resolve("@browserkit/site-mapper"))(
  "fflate",
);

// A user handed over a site pack (h13). site_mapper import read it as a HAR capture ("not a HAR
// or mitmproxy capture: EISDIR") and asked for a site the pack already names.

const ability = {
  kind: "read",
  site: "localhost",
  name: "depotStock",
  description: "How many of an item are in stock",
  inputs: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  ways: [{ kind: "script", runtime: "node", code: "return { count: 1 };" }],
};
const files = {
  "pack.json": JSON.stringify({ format: "browserkit-site-pack", version: 1, site: "localhost" }),
  "model.json": JSON.stringify({ version: 1, site: "localhost", origins: [], operations: [] }),
  "abilities/depotstock.json": JSON.stringify(ability),
};

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "graft-pack-import-"));
  const prev = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = home;
  try {
    return await run(home);
  } finally {
    if (prev === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = prev;
  }
}

for (const shape of ["zip", "folder"]) {
  test(`import installs a site pack given as a ${shape}, with no site asked`, () =>
    withHome(async (home) => {
      const workspace = await mkdtemp(join(tmpdir(), "graft-pack-ws-"));
      if (shape === "zip") {
        const zip = zipSync(
          Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
        );
        await writeFile(join(workspace, "pack.zip"), zip);
      } else {
        await mkdir(join(workspace, "pack", "abilities"), { recursive: true });
        for (const [path, text] of Object.entries(files))
          await writeFile(join(workspace, "pack", path), text);
      }
      const { siteMapperTool } = await import("../dist/definitions.js");
      const result = await siteMapperTool.run(
        { action: "import", files: [shape === "zip" ? "pack.zip" : "pack"] },
        { workspace },
      );
      assert.equal(result.imported[0].site, "localhost");
      const { listAbilities } = await import("@browserkit/site-mapper");
      const names = (await listAbilities("localhost")).map((item) => item.name);
      assert.ok(names.includes("depotStock"), `installed abilities: ${names}`);
      assert.ok(home);
    }));
}

test("code without a url or site says what is missing", async () => {
  const { siteMapperTool } = await import("../dist/definitions.js");
  await assert.rejects(
    siteMapperTool.run({ action: "code", grep: ["x"] }, {}),
    /code needs url or site/,
  );
});
