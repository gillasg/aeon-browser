import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("extension stdout logging cannot corrupt the supervisor's protocol stream", () => {
  const url = new URL("../dist/supervisor-output.js", import.meta.url).href;
  const source = `import { reserveSupervisorOutput } from ${JSON.stringify(url)};
const reply = reserveSupervisorOutput();
console.log('SDK-log');
process.stdout.write('extension-log\\n');
reply('ready\\n'); reply('reply\\n');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ready\nreply\n");
  assert.match(result.stderr, /SDK-log/);
  assert.match(result.stderr, /extension-log/);
});
