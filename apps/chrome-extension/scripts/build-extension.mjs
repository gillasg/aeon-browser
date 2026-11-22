import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const engine = (file) => require.resolve("@browserkit/engine/" + file);

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const STATIC_FILES = [
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
  "pages.css",
  "atmosphere-wallpaper.png",
];

export async function buildExtension() {
  const output = join(appRoot, "native-dist");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const cursorPage = await import(pathToFileURL(engine("cursor-page")).href);
  const buildInfo = buildInfoText();
  const shared = {
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    target: "chrome116",
    loader: { ".ttf": "file" },
    define: { __AEON_NATIVE_TRANSPORT__: "true", __AEON_BUILD_INFO__: JSON.stringify(buildInfo) },
    plugins: [cursorPaintPlugin(cursorPage)],
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
  await Promise.all(
    STATIC_FILES.filter((file) => !file.startsWith("manifest.")).map((file) =>
      copyFile(join(appRoot, file), join(output, file)),
    ),
  );
  await writeManifest(output);
  await copyFile(join(appRoot, "../../packages/ui/src/tokens.css"), join(output, "ui-tokens.css"));
  await writeCursorPage(output);
  await writeFile(join(output, "build-info.json"), buildInfo);
  process.stdout.write(`Built native extension at ${output}\n`);
}

async function writeCursorPage(output) {
  const module = await import(pathToFileURL(engine("cursor-page")).href);
  // Aeon's own extension pages load this file as a script and call the function it leaves behind.
  // Web pages get the painter as an injected function (aeon:cursor-paint), never as a listener.
  const source = [
    "(() => {",
    "  const paint = " + module.cursorFunctionSource() + ";",
    '  if (location.protocol === "chrome-extension:") globalThis.__cursorPaint = paint;',
    "})();",
    "",
  ].join("\n");
  await writeFile(join(output, "cursor-page.js"), source);
}

/** `aeon:cursor-paint` is the painter as a function literal the worker injects; no page event. */
function cursorPaintPlugin(cursorPage) {
  const namespace = "aeon-cursor-paint";
  return {
    name: namespace,
    setup(builder) {
      builder.onResolve({ filter: /^aeon:cursor-paint$/ }, () => ({ path: namespace, namespace }));
      builder.onLoad({ filter: /.*/, namespace }, () => ({
        contents: "export const paintCursor = " + cursorPage.cursorFunctionSource() + ";",
        loader: "js",
      }));
    },
  };
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

// Which revision of Aeon this build used, plus a stamp unique to this build: two builds of one
// revision (a dirty tree, a rebuilt dependency) must still differ, or a stale worker matches.
function buildInfoText() {
  let revision = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: appRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    // Not a git checkout.
  }
  return JSON.stringify({ aeon: revision, build: randomUUID() }, null, 2) + "\n";
}

// Chrome keeps an extension's registered service worker across restarts while the manifest
// version is unchanged, so a rebuilt folder kept running the old worker. Every build gets its own
// version (0.1.<day>.<half-minute of the day>, rising); version_name keeps the readable one.
export function buildVersion(now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  return `0.1.${Math.floor(seconds / 86_400) % 65_536}.${Math.floor((seconds % 86_400) / 2)}`;
}

async function writeManifest(output) {
  const manifest = JSON.parse(await readFile(join(appRoot, "manifest.native.json"), "utf8"));
  manifest.version_name ??= manifest.version;
  manifest.version = buildVersion();
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
