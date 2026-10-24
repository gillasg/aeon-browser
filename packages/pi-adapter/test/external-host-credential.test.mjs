import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runExternalTool } from "../dist/external-tools.js";

// An outside MCP session signs in the same way, and its tool result must not carry the password.

const PASSWORD = "external-host-credential-secret";

async function fakeBitwarden(t) {
  const dir = await mkdtemp(join(tmpdir(), "aeon-ext-bw-"));
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

test("an external session's result never carries the credential", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aeon-ext-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.BROWSERKIT_HOME;
  process.env.BROWSERKIT_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERKIT_HOME;
    else process.env.BROWSERKIT_HOME = previous;
  });
  await writeFile(
    join(home, "password-manager.json"),
    JSON.stringify({ provider: "bitwarden", bitwardenSession: "test-session" }),
  );
  const bw = await fakeBitwarden(t);
  let credential;
  const run = async (_chatId, _toolCallId, input) => {
    credential = await input.codeCell.onCall({
      credential: "login",
      url: "https://shop.example/",
    });
    return JSON.stringify({
      value: { signedIn: Boolean(credential) },
      output: "Signed in.",
      steps: [],
    });
  };

  const result = await withPath(bw, () =>
    runExternalTool(
      {
        sessionDirectory: join(home, "data", "pi-sessions"),
        agentDirectory: undefined,
        preferredInitialModel: undefined,
      },
      run,
      "browser_code",
      "session-1",
      { code: "await bu.signIn()" },
    ),
  );

  assert.equal(credential.logins[0]?.password, PASSWORD, "the engine got the real login");
  assert.ok(!JSON.stringify(result).includes(PASSWORD), "the tool result kept none of it");
  assert.match(JSON.stringify(result), /signedIn/);
});
