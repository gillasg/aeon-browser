import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const engine = (file) => require.resolve("@browser-use-extension/engine/" + file);

const appRoot = fileURLToPath(new URL("../", import.meta.url));

export async function buildExtension() {
  const output = join(appRoot, "native-dist");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const shared = {
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    target: "chrome116",
    loader: { ".ttf": "file" },
    define: { __AEON_NATIVE_TRANSPORT__: "true" },
  };
  const entries = [
    [join(appRoot, "src/native-worker.ts"), "service-worker.js"],
    [join(appRoot, "src/chat-page.ts"), "chat.js"],
    [join(appRoot, "src/viewer-page.tsx"), "viewer.js"],
    [join(appRoot, "src/site-scripts-page.ts"), "site-scripts.js"],
    [join(appRoot, "src/home-page.ts"), "home.js"],
    [join(appRoot, "src/sidepanel-page.ts"), "sidepanel.js"],
    [engine("code-offscreen"), "code-offscreen.js"],
    [engine("code-sandbox"), "code-sandbox.js"],
  ];
  await buildEntries(shared, output, entries);

  await buildViewerWorker(shared, output);
  const files = [
    "manifest.native.json",
    "chat.html",
    "completion-icon.png",
    "aeon-icon.svg",
    ...[16, 32, 48, 128].map((size) => "aeon-icon-" + size + ".png"),
    "viewer.html",
    "site-scripts.html",
    "site-scripts.css",
    "viewer-shell.css",
    "chat.css",
    "home.html",
    "home.css",
    "sidepanel.html",
    "code-offscreen.html",
    "code-sandbox.html",
    "sidepanel.css",
    "geist-latin.woff2",
    "atmosphere.css",
    "sidebar-layout.css",
    "atmosphere-wallpaper.png",
  ];
  await Promise.all(
    files.map((file) =>
      copyFile(
        join(appRoot, file),
        join(output, file.startsWith("manifest.") ? "manifest.json" : file),
      ),
    ),
  );
  await copyFile(join(appRoot, "../../packages/ui/src/tokens.css"), join(output, "ui-tokens.css"));
  await writeBuildInfo(output);
  process.stdout.write(`Built native extension at ${output}\n`);
}

function buildViewerWorker(shared, output) {
  return build({
    ...shared,
    entryPoints: [createRequire(import.meta.url).resolve("monaco-editor/editor/editor.worker.js")],
    outfile: join(output, "viewer-worker.js"),
  });
}

function buildEntry(shared, output, entry, file) {
  return build({
    ...shared,
    minify: file === "viewer.js",
    entryPoints: [entry],
    outfile: join(output, file),
  });
}

// The service worker carries the boost engine; its content script is built beside it.
async function buildEntries(shared, output, entries) {
  const { boostEngineDefine, writeBoostContent } = await import(
    pathToFileURL(engine("boosts-build")).href
  );
  const boosts = await boostEngineDefine();
  await writeBoostContent(join(output, "boosts-content.js"));
  const worker = { ...shared, define: { ...shared.define, ...boosts } };
  await Promise.all(
    entries.map(([entry, file]) =>
      buildEntry(file === "service-worker.js" ? worker : shared, output, entry, file),
    ),
  );
}

// Which revision of each linked repo (core, the Browser Use Extension, ...) this build used.
async function writeBuildInfo(output) {
  const revisions = execFileSync(
    process.execPath,
    [join(appRoot, "../../scripts/link-repos.mjs"), "--revisions"],
    { encoding: "utf8" },
  );
  await writeFile(join(output, "build-info.json"), revisions);
}
