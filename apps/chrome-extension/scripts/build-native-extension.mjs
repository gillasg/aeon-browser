import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildExtension } from "./build-extension.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const output = join(appRoot, "native-dist");

await buildExtension();
await buildOrb();

// The orb: a content script that draws over pages, and orb.html, the bubble it frames.
async function buildOrb() {
  const shared = { bundle: true, platform: "browser", format: "iife", target: "chrome116" };
  await Promise.all([
    build({
      ...shared,
      entryPoints: [join(appRoot, "src/orb/orb-content.ts")],
      outfile: join(output, "orb-content.js"),
    }),
    build({
      ...shared,
      entryPoints: [join(appRoot, "src/orb/orb-page.ts")],
      outfile: join(output, "orb.js"),
      define: { __AEON_NATIVE_TRANSPORT__: "true" },
    }),
    ...["orb.html", "orb.css"].map((file) => copyFile(join(appRoot, file), join(output, file))),
  ]);
}
