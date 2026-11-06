import assert from "node:assert/strict";
import test from "node:test";
import {
  browserProfileGuard,
  PROFILE_REFUSAL,
  touchesBrowserProfile,
} from "../dist/browser-profile-guard.js";

test("shell and file calls into a browser's profile folder are refused", () => {
  const refused = [
    [
      "bash",
      {
        command:
          'cp "/c/Users/A/AppData/Local/Google/Chrome/User Data/Default/Login Data" /tmp/ld.db',
      },
    ],
    [
      "bash",
      { command: 'cd "/c/Users/A/AppData/Local/Google/Chrome/User Data" && ls */Preferences' },
    ],
    [
      "powershell",
      {
        command:
          "Get-Item 'C:\\Users\\A\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies'",
      },
    ],
    ["read", { path: "/home/a/.config/google-chrome/Default/History" }],
    [
      "bash",
      {
        command:
          "sqlite3 ~/Library/Application\\ Support/Google/Chrome/Default/Login\\ Data .tables",
      },
    ],
  ];
  for (const [tool, input] of refused)
    assert.equal(touchesBrowserProfile(tool, input), true, JSON.stringify(input));
});

test("ordinary shell work and Aeon's own browser tools pass", () => {
  assert.equal(touchesBrowserProfile("bash", { command: "ls workspace && cat notes.md" }), false);
  assert.equal(
    touchesBrowserProfile("write", { path: "report.md", content: "Chrome is a browser" }),
    false,
  );
  assert.equal(touchesBrowserProfile("browser_code", { code: "// Chrome User Data" }), false);
});

test("the guard blocks the call with a reason the model can act on", () => {
  let handler;
  browserProfileGuard().factory({ on: (_event, fn) => (handler = fn) });
  const blocked = handler({
    toolName: "bash",
    input: { command: "cat '/c/x/Chrome/User Data/Local State'" },
  });
  assert.deepEqual(blocked, { block: true, reason: PROFILE_REFUSAL });
  assert.equal(handler({ toolName: "bash", input: { command: "pwd" } }), undefined);
});
