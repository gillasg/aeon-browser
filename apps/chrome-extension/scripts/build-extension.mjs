import { createRequire } from "node:module";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
    [join(appRoot, "src/code-offscreen.ts"), "code-offscreen.js"],
    [join(appRoot, "src/code-sandbox.ts"), "code-sandbox.js"],
  ];
  await Promise.all(entries.map(([entry, file]) => buildEntry(shared, output, entry, file)));

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
