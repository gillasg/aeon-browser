import assert from "node:assert/strict";
import test from "node:test";
import {
  IDLE_WAIT_REFUSAL,
  idleWaitGuard,
  idleWaitSeconds,
  MAX_IDLE_WAIT_SECONDS,
  waitsTooLong,
} from "../dist/idle-wait-guard.js";

test("long idle waits in a shell are refused", () => {
  const refused = [
    ["bash", { command: "sleep 1680" }],
    ["bash", { command: "sleep 480 && echo done" }],
    ["bash", { command: "sleep 2m" }],
    ["bash", { command: "sleep 20; sleep 20" }],
    ["bash", { command: "cd /tmp && sleep 45 && curl -s https://x.com" }],
    ["powershell", { command: "Start-Sleep -Seconds 120" }],
    ["powershell", { command: "Start-Sleep 90" }],
    ["powershell", { command: "Start-Sleep -Milliseconds 60000" }],
    ["powershell", { command: "[System.Threading.Thread]::Sleep(45000)" }],
    ["bash", { command: "timeout /t 60" }],
    ["bash", { command: "ping -n 61 127.0.0.1 > nul" }],
  ];
  for (const [tool, input] of refused) assert.equal(waitsTooLong(tool, input), true, input.command);
  assert.equal(idleWaitSeconds("sleep 1m 30s"), 90);
});

test("real work and short waits keep running", () => {
  const allowed = [
    ["bash", { command: "pnpm build" }],
    ["bash", { command: "sleep 5 && ls" }],
    ["bash", { command: `sleep ${MAX_IDLE_WAIT_SECONDS}` }],
    ["bash", { command: "while ! curl -s localhost:3000; do sleep 2; done" }],
    ["bash", { command: "grep -r 'sleep 600' src" }],
    ["powershell", { command: "Start-Sleep -Milliseconds 500" }],
    ["read", { path: "sleep 999" }],
  ];
  for (const [tool, input] of allowed)
    assert.equal(waitsTooLong(tool, input), false, input.command);
});

test("the guard blocks with a reason that says what to do instead", () => {
  let handler;
  idleWaitGuard().factory({ on: (_event, fn) => (handler = fn) });
  assert.deepEqual(handler({ toolName: "bash", input: { command: "sleep 1680" } }), {
    block: true,
    reason: IDLE_WAIT_REFUSAL,
  });
  assert.equal(handler({ toolName: "bash", input: { command: "ls" } }), undefined);
  assert.match(IDLE_WAIT_REFUSAL, /try again later/);
});
