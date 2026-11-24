import assert from "node:assert/strict";
import test from "node:test";
import {
  CHROME_FLAGS,
  CHROME_LAUNCH_FLAGS,
  chromeRelaunchCommand,
  mergeChromeFlags,
  missingChromeFlags,
} from "../dist/index.js";

test("the canonical list is the six decided flags, none a stealth tell", () => {
  assert.deepEqual(CHROME_FLAGS, [
    "--extensions-on-chrome-urls",
    "--silent-debugger-extension-api",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
  ]);
  for (const item of CHROME_LAUNCH_FLAGS) assert.ok(item.purpose.length > 0);
  for (const bad of ["--test-type", "--no-sandbox"])
    assert.ok(!CHROME_FLAGS.some((flag) => flag.startsWith(bad)));
});

test("merging folds into an existing --disable-features list and never duplicates", () => {
  const merged = mergeChromeFlags(["--profile-directory=A", "--disable-features=Foo"]);
  assert.deepEqual(
    merged.filter((arg) => arg.startsWith("--disable-features=")),
    ["--disable-features=Foo,CalculateNativeWinOcclusion"],
  );
  assert.equal(merged[0], "--profile-directory=A");
  assert.deepEqual(mergeChromeFlags(merged), merged);
  const twoLists = mergeChromeFlags(["--disable-features=A", "--disable-features=B,A"]);
  assert.deepEqual(
    twoLists.filter((arg) => arg.startsWith("--disable-features=")),
    ["--disable-features=A,B,CalculateNativeWinOcclusion"],
  );
});

test("missing-flag detection reads the feature inside a merged list", () => {
  const line = `chrome ${CHROME_FLAGS.slice(0, 5).join(" ")} --disable-features=Foo,CalculateNativeWinOcclusion`;
  assert.deepEqual(missingChromeFlags([line]), []);
  assert.deepEqual(missingChromeFlags(["chrome --disable-features=Foo"]), CHROME_FLAGS);
  assert.deepEqual(missingChromeFlags([]), CHROME_FLAGS);
  assert.deepEqual(missingChromeFlags(["chrome --silent-debugger-extension-api-x"]), CHROME_FLAGS);
});

test("the relaunch command is copy-pasteable on each OS", () => {
  const all = CHROME_FLAGS.join(" ");
  assert.equal(chromeRelaunchCommand("darwin"), `open -na "Google Chrome" --args ${all}`);
  assert.equal(chromeRelaunchCommand("MacIntel"), `open -na "Google Chrome" --args ${all}`);
  assert.equal(chromeRelaunchCommand("linux"), `google-chrome ${all}`);
  assert.equal(
    chromeRelaunchCommand("win32"),
    `Start-Process chrome.exe -ArgumentList ${CHROME_FLAGS.map((f) => `'${f}'`).join(",")}`,
  );
  assert.equal(chromeRelaunchCommand("Windows"), chromeRelaunchCommand("win32"));
});
