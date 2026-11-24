// The recording Chrome setup: the script parses, the profile hides saved-group chips and films in
// English, the frame probe never depends on the active tab or a public site, and the frame verdict
// refuses a visible bookmarks bar.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const setup = join(scripts, "setup-recording-chrome.sh");

test("setup-recording-chrome.sh parses (bash -n)", () => {
  // Git Bash on Windows takes D:/a/... but not backslashes.
  execFileSync("bash", ["-n", process.platform === "win32" ? setup.replace(/\\/g, "/") : setup]);
});

test("the probe reads its own local tab, never the active tab or a public site", () => {
  const text = readFileSync(setup, "utf8");
  assert.doesNotMatch(text, /example\.com/);
  assert.doesNotMatch(text, /no tab/);
  assert.match(text, /browser\.openTab\('http:\/\/127\.0\.0\.1:\$PROBE_PORT\//);
  assert.match(text, /page\.close\(\)/);
  assert.match(text, /--lang=en-US/);
  assert.match(text, /LC_ALL=en_US\.UTF-8/);
  assert.match(text, /rm -rf "\$PROFILE\/Default\/Sync Data"/);
});

test("seeded prefs hide the bookmarks bar, stop auto-pinning groups and force English", () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-prefs-"));
  const ext = join(dir, "ext");
  mkdirSync(ext);
  writeFileSync(join(ext, "manifest.json"), JSON.stringify({ permissions: ["tabs"] }));
  const pref = join(dir, "Preferences");
  writeFileSync(
    pref,
    JSON.stringify({
      bookmark_bar: { show_on_all_tabs: true },
      intl: { accept_languages: "de-DE,de" },
    }),
  );
  execFileSync("python3", [join(scripts, "seed-recording-prefs.py"), pref, ext, "abc"]);
  const d = JSON.parse(readFileSync(pref, "utf8"));
  assert.equal(d.bookmark_bar.show_on_all_tabs, false);
  assert.equal(d.tab_groups.auto_pin_new_tab_groups, false);
  assert.equal(d.intl.accept_languages, "en-US,en");
  assert.equal(d.extensions.settings.abc.path, ext);
});

const verdict = (frame) =>
  spawnSync(
    "python3",
    [join(scripts, "check-recording-frame.py"), JSON.stringify(frame), "2", "1280", "720"],
    {
      encoding: "utf8",
    },
  );

test("a clean frame passes", () => {
  const r = verdict({ dpr: 2, outer: 720, inner: 633, w: 1280 });
  assert.equal(r.status, 0, r.stderr);
});

test("a visible bookmarks bar fails the frame check", () => {
  const r = verdict({ dpr: 2, outer: 720, inner: 601, w: 1280 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bookmarks bar/);
});

test("an unreadable probe fails with its error", () => {
  const r = spawnSync(
    "python3",
    [join(scripts, "check-recording-frame.py"), "CODE_ERROR: boom", "2", "1280", "720"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not be read: CODE_ERROR: boom/);
});
