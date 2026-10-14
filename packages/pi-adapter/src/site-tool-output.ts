import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Results from site APIs and crawls can be large: the model sees a bounded preview, and the
// whole result is saved in the chat's workspace for browser_code or later tools to read.

const PREVIEW_CHARS = 12_000;

export interface ToolText {
  content: { type: "text"; text: string }[];
  details: undefined;
  isError?: boolean;
}

export function textResult(value: unknown, isError = false): ToolText {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: "text", text }], details: undefined, ...(isError ? { isError } : {}) };
}

export function errorResult(error: unknown): ToolText {
  return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
}

const safeName = (text: string): string =>
  text
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "result";

/** The value itself when small; otherwise a preview and the path of the saved file. */
export async function boundedResult(
  value: unknown,
  workspace: string | undefined,
  folder: string,
  name: string,
  extension = "json",
): Promise<ToolText> {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (text.length <= PREVIEW_CHARS || !workspace)
    return textResult(text.slice(0, PREVIEW_CHARS * 2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relative = join(folder, `${safeName(name)}-${stamp}.${extension}`);
  await mkdir(join(workspace, folder), { recursive: true });
  await writeFile(join(workspace, relative), text);
  return textResult(
    `${text.slice(0, PREVIEW_CHARS)}\n…\n[${text.length} characters in all; the whole result is saved in the workspace as ${relative.replace(/\\/g, "/")}]`,
  );
}
