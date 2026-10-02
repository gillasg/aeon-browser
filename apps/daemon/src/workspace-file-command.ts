import { readGitBase } from "./workspace-git-base.js";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, extname } from "node:path";
import { asChatId } from "@pippin/domain";
import type { DaemonUiRequest } from "@pippin/protocol";
import type { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
import { completeCommand } from "./chat-command-complete.js";

export async function sendWorkspaceFile(
  socket: WebSocket,
  service: ChatService,
  request: Extract<DaemonUiRequest, { operation: "workspace.file" }>,
): Promise<void> {
  const chat = service.getChat(asChatId(request.payload.chatId));
  if (!chat) throw new Error("Chat not found.");
  const root = await realpath(chat.workingDirectory);
  const path = await realpath(resolve(root, request.payload.path));
  const child = relative(root, path);
  if (child === ".." || child.startsWith("../") || child.startsWith("..\\") || isAbsolute(child))
    throw new Error(
      "This file is outside the chat workspace. Open it from a chat in that project.",
    );
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Choose a file, not a directory.");
    if (stat.size > 1_048_576) throw new Error("This viewer supports text files up to 1 MiB.");
    const bytes = Buffer.alloc(1_048_577);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1_048_576) throw new Error("The file grew beyond the viewer size limit.");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    if (content.includes("\0")) throw new Error("Binary files cannot be displayed as text.");
    let original = await readGitBase(path);
    const result = {
      kind: "workspace.file" as const,
      path,
      content,
      language: language(path),
      original,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 900_000) {
      original = null;
      result.original = original;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 900_000)
      throw new Error("This file is too large for the local viewer transport.");
    completeCommand(socket, request, result);
  } finally {
    await file.close();
  }
}

function language(path: string): string {
  const languages: Record<string, string> = {
    md: "markdown",
    markdown: "markdown",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    py: "python",
    css: "css",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    ps1: "powershell",
    rs: "rust",
    go: "go",
    cs: "csharp",
    java: "java",
    cpp: "cpp",
    c: "c",
    sql: "sql",
    xml: "xml",
    toml: "ini",
  };
  return languages[extname(path).slice(1).toLowerCase()] ?? "plaintext";
}
