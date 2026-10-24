import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";

// A password manager's answer goes from the machine to the browser engine, which types it into
// the page. It must never be recorded by Aeon: not in the tool result the model rereads, not in
// its details (the trace's steps), and not in a progress update.

const PASSWORD = "hunter2-credential-secret";

async function fakeBitwarden(t) {
  const dir = await mkdtemp(join(tmpdir(), "aeon-bw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outputs = join(dir, "outputs.json");
  await writeFile(
    outputs,
    JSON.stringify({
      "list items": [
        {
          id: "login-1",
          name: "Shop",
          login: {
            username: "me@example.com",
            password: PASSWORD,
            uris: [{ uri: "https://shop.example/" }],
          },
        },
      ],
    }),
  );
  const script = join(dir, "bw.mjs");
  await writeFile(
    script,
    `import { readFileSync } from "node:fs";
const outputs = JSON.parse(readFileSync(${JSON.stringify(outputs)}, "utf8"));
const args = process.argv.slice(2).join(" ");
const hit = Object.keys(outputs).find((key) => args.startsWith(key));
if (!hit) process.exit(1);
process.stdout.write(JSON.stringify(outputs[hit]));
`,
  );
  if (process.platform === "win32")
    await writeFile(join(dir, "bw.cmd"), `@node "${script}" %*\r\n`);
  else {
    await writeFile(join(dir, "bw"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
    await chmod(join(dir, "bw"), 0o755);
  }
  return dir;
}

async function withPath(dir, work) {
  const saved = process.env.PATH;
  process.env.PATH = dir + delimiter + saved;
  try {
    return await work();
  } finally {
    process.env.PATH = saved;
  }
}

test("a credential or site-rules answer never lands in a result, step or progress update", async (t) => {
  const toolDirectory = await fakeBitwarden(t);
  const dataDirectory = await mkdtemp(join(tmpdir(), "aeon-signin-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(
    join(dataDirectory, "password-manager.json"),
    JSON.stringify({ provider: "bitwarden", bitwardenSession: "test-session" }),
  );
  const rules = { blocked: ["blocked.example"], only: ["bank.example"], allow: ["shop.example"] };

  let credential;
  let siteRules;
  const updates = [];
  const run = async (_chatId, _toolCallId, input) => {
    const cell = input.codeCell;
    credential = await cell.onCall({ credential: "login", url: "https://shop.example/login" });
    siteRules = await cell.onCall({ siteRules: true });
    cell.onProgress([
      { index: 0, action: { op: "fill", target: { tabId: 7 } }, disposition: "completed" },
    ]);
    return JSON.stringify({
      output: "Signed in as me@example.com",
      value: { signedIn: true, provider: "Bitwarden" },
      steps: [
        {
          index: 0,
          action: { op: "fill", target: { tabId: 7 } },
          disposition: "completed",
          result: { kind: "ok" },
        },
      ],
    });
  };
  const tool = createBrowserCodeTool("chat-1", run, undefined, undefined, {
    dataDirectory,
    siteRules: () => rules,
  });

  const result = await withPath(toolDirectory, () =>
    tool.execute("call-1", { code: "await bu.signIn()" }, undefined, (update) =>
      updates.push(update),
    ),
  );

  // The engine got the real login and the rules...
  assert.equal(credential.provider, "Bitwarden");
  assert.equal(credential.logins[0]?.password, PASSWORD);
  assert.deepEqual(siteRules, rules);
  assert.ok(updates.length > 0, "the cell reported progress");

  // ...and Aeon kept none of it.
  const recorded = JSON.stringify([result.content, result.details, updates]);
  assert.ok(!recorded.includes(PASSWORD), "the password is not recorded");
  assert.doesNotMatch(recorded, /bank\.example|blocked\.example|test-session/);
  assert.match(recorded, /Signed in as me@example\.com/);
});
