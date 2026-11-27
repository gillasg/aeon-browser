// Boosts ship inside Graft's extension (see embed-build.mjs). This builds only the pure modules
// (no chrome.* at import time) the unit tests import.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  bundle: true,
  logLevel: "warning",
  legalComments: "none",
  entryPoints: [`${root}src/testing.ts`],
  outfile: `${root}build-test/lib.mjs`,
  format: "esm",
  platform: "node",
  target: "node22",
});
