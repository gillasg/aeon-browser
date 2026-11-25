// The conformance scenarios. Each one opens its own foreground tabs in its own browser_code
// session, drives Aeon's real engine against the fixture site and records every step. Cells
// project the facts that matter (outcome, text, status) so transcripts stay exact and readable.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const q = JSON.stringify;
/** Opens a tab and keeps it for cleanup; `page` is the scenario's main tab. */
const open = (url, name = "page") =>
  `${name} = await browser.openTab(${q(url)}, {foreground: true, newTab: true}); cfOpened.push(${name}); await ${name}.title()`;

// The user agent names the OS, so the golden keeps only its browser brand, and reduced motion
// follows the host's accessibility setting (on for macOS CI runners), so the golden keeps a
// placeholder. The canary still compares the whole raw fingerprint, reducedMotion included,
// against the baseline taken earlier in the same run.
const fingerprints = {};
const neutral = (print) => ({
  ...print,
  ua: /HeadlessChrome\/\d+/.test(print?.ua ?? "") ? "HeadlessChrome" : print?.ua,
  reducedMotion: typeof print?.reducedMotion === "boolean" ? "<HOST>" : print?.reducedMotion,
});
const FINGERPRINT = `await page.evaluate(() => ({
  viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, ua: navigator.userAgent,
  onLine: navigator.onLine, dark: matchMedia("(prefers-color-scheme: dark)").matches,
  print: matchMedia("print").matches, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
}))`;

export const scenarios = [
  {
    name: "baseline",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/baseline`));
      // On macOS Chrome's debugger infobar slides in after the first attach (~250ms), shrinking
      // innerHeight from 656 to 600; read the fingerprint once the viewport height has settled.
      const settledFingerprint = `await page.evaluate(async () => {
        let prev = innerHeight;
        for (let i = 0; i < 6; i++) {
          await new Promise((done) => setTimeout(done, 150));
          if (innerHeight === prev && i >= 1) break;
          prev = innerHeight;
        }
        return {
          viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, ua: navigator.userAgent,
          onLine: navigator.onLine, dark: matchMedia("(prefers-color-scheme: dark)").matches,
          print: matchMedia("print").matches, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        };
      })`;
      fingerprints.baseline = await r.ok("fingerprint", settledFingerprint, neutral);
    },
  },
  {
    name: "hangs",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/hangs`));
      await r.err("busy-loop", `await page.evaluate(() => { for (;;) {} })`, /^TIMEOUT/);
      await r.ok("alive-after", `await page.evaluate(() => 1)`);
      await r.err(
        "auth-401",
        `await page.goto(${q(`${site.primary}/auth`)})`,
        /ERR_INVALID_AUTH_CREDENTIALS/,
      );
      const gateAt = Date.now();
      await r.ok(
        "gate-pending",
        `try { await page.goto(${q(`${site.primary}/gate/slow`)}, {timeout: 1500}); "loaded" } catch (e) { String(e.message).split("\\n")[0] }`,
      );
      r.check("gate-pending-bounded", Date.now() - gateAt < 4000);
      r.check("gate-held", site.gate.waiting("slow"), (v) => v === 1);
      site.gate.release("slow");
      await r.ok(
        "gate-released",
        `await page.goto(${q(`${site.primary}/gate/slow`)}); await page.textContent("#gate")`,
      );
    },
  },
  {
    name: "app",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/app`));
      await r.ok(
        "snapshot",
        `(await page.snapshot()).nodes.map((n) => n.ref + " " + n.role + " " + (n.name ?? ""))`,
      );
      await r.ok("fill", `(await page.fill("#name", "Ada")).effect`);
      await r.ok(
        "select",
        `await page.selectOption("#color", "g"); await page.inputValue("#color")`,
      );
      await r.ok("click", `(await page.click("#save")).outcome`);
      await r.text("result", `await page.textContent("#out")`);
      await r.err("fill-covered", `await page.fill("#covered", "x")`, /^TARGET_BLOCKED/);
      await r.ok(
        "fill-covered-force",
        `await page.fill("#covered", "forced", {force: true}); await page.inputValue("#covered")`,
      );
      // A cover that stays is refused well before the timeout; the margin absorbs a loaded runner.
      const coveredAt = Date.now();
      await r.err(
        "click-covered",
        `await page.click("#covered-btn", {timeout: 20000})`,
        /^TARGET_BLOCKED/,
      );
      r.check("click-covered-fast", Date.now() - coveredAt < 10000);
      await r.ok("fill-remount", `await page.fill("#live", "abc"); await page.inputValue("#live")`);
      await r.err("stale-ref", `await bu.click("e999")`);
    },
  },
  {
    name: "spa",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/spa`));
      await r.ok("push-state", `(await page.click("#next")).outcome`);
      await r.ok(
        "after-push",
        `({url: page.url(), title: await page.title(), view: await page.textContent("#view")})`,
      );
      await r.ok("reload-server", `await page.reload(); await page.textContent("#view")`);
      await r.ok("bf-a", `await page.goto(${q(`${site.primary}/bf/a`)}); await page.title()`);
      await r.ok("bf-to-b", `await page.click("#to-b"); await page.title()`);
      await r.ok("bf-back", `await page.goBack(); ({url: page.url(), title: await page.title()})`);
    },
  },
  {
    name: "frames",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/frames`));
      await r.eventually(
        "frame-urls",
        `(await page.frames()).map((f) => f.url)`,
        (v) => Array.isArray(v) && v.length === 6,
      );
      await r.ok(
        "snapshot",
        `(await page.snapshot()).nodes.map((n) => n.ref + " " + n.role + " " + (n.name ?? ""))`,
      );
      await r.ok("click-same-text", `(await page.locator("text=Same").click()).outcome`);
      await r.ok("click-cross-text", `(await page.locator("text=Cross").click()).outcome`);
      await r.ok("click-cross-ref", `(await bu.click("f2:e1")).outcome`);
      await r.ok("embedded", `(await page.read()).embedded.map((e) => e.where + " = " + e.text)`);
    },
  },
  {
    name: "dialogs",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/dialogs`));
      await r.ok(
        "alert",
        `const a = await page.click("#alert"); ({dialog: a.receipt.dialog, out: await page.textContent("#out")})`,
      );
      await r.ok(
        "confirm",
        `const a = await page.click("#confirm"); ({dialog: a.receipt.dialog, out: await page.textContent("#out")})`,
      );
      await r.ok(
        "prompt",
        `const a = await page.click("#prompt"); ({dialog: a.receipt.dialog, out: await page.textContent("#out")})`,
      );
      await r.ok(
        "dialog-during-input",
        `const a = await page.fill("#typed", "abc"); ({effect: a.effect, dialog: a.receipt?.dialog ?? null, value: await page.inputValue("#typed")})`,
      );
      await r.ok(
        "onload",
        `await page.goto(${q(`${site.primary}/dialogs/onload`)}); await page.title()`,
      );
      await r.ok(
        "frame-dialog",
        `await page.goto(${q(`${site.primary}/dialogs/frame`)}); await page.snapshot(); (await page.click("f1:e1")).receipt.dialog`,
      );
      await r.eventually(
        "frame-dialog-dom",
        `await page.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("#inner").textContent)`,
        (v) => v === "inner true",
      );
    },
  },
  {
    name: "upload",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/upload`));
      await r.ok(
        "set-file",
        `const saved = await artifact("upload-payload.txt", "upload payload\\n"); (await page.upload("#file", [saved.path])) && await page.evaluate(() => document.querySelector("#file").files[0]?.name)`,
      );
      const mark = site.log.length;
      await r.ok("submit", `(await page.click("#send")).outcome`);
      await r.eventually(
        "upload-result",
        `await page.textContent("#got")`,
        (v) => typeof v === "string" && v.startsWith("got"),
      );
      const post = site.since(mark, "/upload").find((entry) => entry.method === "POST");
      r.check(
        "server-got-file",
        {
          type: post?.headers["content-type"]?.split(";")[0] ?? null,
          filename: /filename="([^"]+)"/.exec(post?.body ?? "")?.[1] ?? null,
          payload: post?.body.includes("upload payload") ?? false,
        },
        (v) => v.payload && v.filename === "upload-payload.txt",
      );
    },
  },
  {
    name: "download",
    async run(r, { site, harness }) {
      await r.ok("open", open(`${site.primary}/download-page`));
      await r.ok(
        "download",
        `const d = await page.download(${q(`${site.primary}/download`)}); ({persisted: d.persisted, started: typeof d.downloadId === "number"})`,
      );
      await r.until(
        "on-disk",
        async () => findFile(harness.downloads, "report.txt"),
        (v) => v === "report body 12345\n",
      );
    },
  },
  {
    name: "drag",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/drag`));
      await r.ok("drag", `await page.drag(70, 70, 375, 95); await page.textContent("#out")`);
    },
  },
  {
    name: "csp",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/csp`));
      await r.ok("inline-blocked", `await page.textContent("#out")`);
      await r.ok("evaluate-under-csp", `await page.evaluate(() => 6 * 7)`);
      await r.ok(
        "snapshot",
        `(await page.snapshot()).nodes.map((n) => n.role + " " + (n.name ?? ""))`,
      );
    },
  },
  {
    name: "network",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/network`));
      const mark = site.log.length;
      await r.ok("run", `await page.click("#go"); await page.textContent("#out")`);
      // Other scenarios share the server, so keep only this page's requests.
      const mine = /^\/(api\/|worker\.js|r\/|landed|gate\/abort|network\/frame)/;
      const truth = site
        .since(mark)
        .filter((entry) => mine.test(entry.target))
        .map((entry) => `${entry.site} ${entry.method} ${entry.target}`);
      r.check(
        "server-log",
        truth,
        (v) => v.includes("CROSS GET /api/frame") && v.includes("PRIMARY GET /landed"),
      );
      await r.ok(
        "captured",
        `(await page.network.list()).map((x) => x.method + " " + x.url + " " + x.status).sort()`,
      );
      await r.ok(
        "redirect-hops",
        `(await page.network.list("/r/")).map((x) => x.url + " " + x.status)`,
      );
      r.check(
        "redirect-hops-match-log",
        r.last("redirect-hops").length,
        (v) => v === truth.filter((t) => t.includes(" /r/")).length,
      );
      await r.ok("xhr-body", `(await page.network.list({method: "POST"}))[0]?.requestBody ?? null`);
      await r.ok(
        "worker-request",
        `(await page.network.list("/api/worker")).map((x) => x.url + " " + x.status)`,
      );
      r.check("worker-request-captured", r.last("worker-request").length, (v) => v === 1);
      await r.ok(
        "cross-frame-fetch",
        `(await page.network.list("/api/frame")).map((x) => x.url + " " + x.status)`,
      );
      r.check("cross-frame-fetch-captured", r.last("cross-frame-fetch").length, (v) => v === 1);
      await r.ok(
        "aborted",
        `(await page.network.list("/gate/abort")).map((x) => x.url + " " + (x.status ?? x.state ?? x.error))`,
      );
      await r.ok(
        "cross-frame-first-request",
        `(await page.network.list("/network/frame")).map((x) => x.url + " " + x.status)`,
      );
    },
  },
  {
    name: "console",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/console`));
      await r.ok("start", `(await page.console()) && 0`);
      await r.ok("log", `(await page.click("#log")).outcome`);
      await r.eventually(
        "entries",
        `(await page.console()).map((m) => m.level + " " + m.text)`,
        (v) =>
          Array.isArray(v) &&
          v.some((line) => line.includes("plain log")) &&
          v.some((line) => line.includes("bad thing")),
      );
      await r.eventually(
        "errors-only",
        `(await page.console({errors: true})).map((m) => m.level + " " + m.text)`,
        (v) => Array.isArray(v) && v.some((line) => line.includes("bad thing")),
      );
    },
  },
  {
    name: "visual",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/visual`));
      await r.ok("screenshot-format", `(await page.screenshot({format: "png"})).mimeType`);
      r.check("screenshot-png", r.last("screenshot-format"), (v) => v === "image/png");
      await r.image(
        "pixels",
        `({data: (await page.cdp("Page.captureScreenshot", {format: "png"})).data})`,
        [
          [100, 100],
          [300, 100],
          [200, 300],
        ],
      );
    },
  },
  {
    name: "non_html",
    async run(r, { site }) {
      await r.ok("json", `${open(`${site.primary}/data.json`)}; (await page.read()).text`);
      await r.ok(
        "text",
        `await page.goto(${q(`${site.primary}/plain.txt`)}); (await page.read()).text`,
      );
      await r.ok(
        "png",
        `await page.goto(${q(`${site.primary}/image.png`)}); await page.evaluate(() => { const i = document.querySelector("img"); return i ? [i.naturalWidth, i.naturalHeight] : null; })`,
      );
    },
  },
  {
    name: "popups",
    async run(r, { site, harness }) {
      // Other scenarios open tabs at the same time, so count only this page's popups.
      const popups = async () =>
        (await harness.tabs()).filter(
          (t) => t.url === `${site.primary}/popup/a` || t.url === `${site.primary}/popup/b`,
        ).length;
      await r.ok("open", open(`${site.primary}/popups`));
      await r.ok("window-open", `(await page.click("#pop")).receipt.popups.length`);
      await r.ok("target-blank", `(await page.click("#blank")).receipt.popups.length`);
      await r.until("chrome-tabs", popups, (v) => v === 2);
      await r.ok(
        "close-popups",
        `let n = 0; for (const t of await browser.tabs()) if (/\\/popup\\/[ab]$/.test(t.url)) { await browser.closeTab(t.id); n++ } n`,
      );
      await r.until("chrome-tabs-after", popups, (v) => v === 0);
    },
  },
  {
    name: "inert-main",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/inert-main`));
      await r.ok(
        "snapshot",
        `(await page.snapshot()).nodes.map((n) => n.role + " " + (n.name ?? ""))`,
      );
      await r.ok(
        "state",
        `const t = String(await bu.state()); ({accept: /button "Accept"/.test(t), modalText: t.includes("Accept cookies?"), hidden: t.includes("Hidden action")})`,
      );
    },
  },
  {
    name: "policy",
    async run(r, { site }) {
      await r.ok("open", open(`${site.primary}/policy`));
      const blocked = `http://blocked.test:${site.port}/policy`;
      await r.err("blocked-navigate", `await page.goto(${q(blocked)})`);
      await r.ok(
        "blocked-fast",
        `const t = Date.now(); try { await page.goto(${q(blocked)}) } catch {} Date.now() - t < 1000`,
      );
      await r.ok("still-on-allowed", `page.url()`);
    },
  },
  {
    name: "leak_canary",
    last: true,
    async run(r, { site, harness }) {
      await r.ok("open", open(`${site.primary}/baseline`));
      const fresh = await r.ok("fingerprint", FINGERPRINT, neutral);
      r.check("matches-baseline", JSON.stringify(fresh) === JSON.stringify(fingerprints.baseline));
      await r.ok("no-dialog", `await page.evaluate(() => 1)`);
      // The canary's own tab, the extension welcome page and Chrome's two startup blanks.
      await r.until(
        "chrome-tabs",
        async () => (await harness.tabs()).length,
        (v) => v === harness.baseTabs + 1,
      );
    },
  },
];

async function findFile(root, name) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  const hit = entries.find((entry) => entry.isFile() && entry.name === name);
  return hit ? readFile(join(hit.parentPath, hit.name), "utf8") : null;
}
