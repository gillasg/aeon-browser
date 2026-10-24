import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeChatFiles } from "../dist/chat-deletion.js";

const chatId = "11111111-1111-4111-8111-111111111111";

async function layout() {
  const root = await mkdtemp(join(tmpdir(), "aeon-delete-"));
  const workspace = join(root, "workspaces", chatId);
  const sessions = join(root, "pi-sessions");
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "x");
  const sessionFile = join(sessions, "s.jsonl");
  await writeFile(sessionFile, "{}");
  return { root, workspace, sessionFile };
}

const record = (workingDirectory, sessionFile) => ({
  chatId,
  workingDirectory,
  piReference: { sessionId: "s", sessionFile },
});

test("deleting a chat removes its own workspace and session file", async () => {
  const { workspace, sessionFile } = await layout();
  await removeChatFiles(record(workspace, sessionFile), []);
  assert.equal(existsSync(workspace), false);
  assert.equal(existsSync(sessionFile), false);
});

test("a project folder and a session file another chat uses are kept", async () => {
  const { root, sessionFile } = await layout();
  const project = join(root, "my-project");
  await mkdir(project);
  const other = { chatId: "other", piReference: { sessionId: "s", sessionFile } };
  await removeChatFiles(record(project, sessionFile), [other]);
  assert.equal(existsSync(project), true);
  assert.equal(existsSync(sessionFile), true);
});
