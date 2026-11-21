import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { namedErrorText } from "@browserkit/tools/definitions";

// Results from site APIs and crawls can be large: the model sees a bounded preview, and the
// whole result is saved in the chat's workspace for browser_code or later tools to read.

const PREVIEW_CHARS = 12_000;
const outputMode = new AsyncLocalStorage<{ full: boolean }>();

/** `--json` prints the whole result. The preview path must not run inside this. */
export function fullOutput<T>(work: () => Promise<T>): Promise<T> {
  return outputMode.run({ full: true }, work);
}

/**
 * A preview cut that never ends inside a JSON string. Returns "" when every cut inside the limit
 * would split a string, so the caller can print the file path alone.
 */
export function cutAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let inString = false;
  let escape = false;
  let safe = 0;
  const end = Math.min(limit, text.length);
  for (let index = 0; index < end; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') {
        inString = false;
        safe = index + 1;
      }
      continue;
    }
    if (char === '"') inString = true;
    else if (",\n{}[]".includes(char)) safe = index + 1;
  }
  return text.slice(0, safe);
}

export interface ToolText {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown> | undefined;
  isError?: boolean;
}

export function textResult(
  value: unknown,
  isError = false,
  details?: Record<string, unknown>,
): ToolText {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError } : {}),
  };
}

/** Every failure is led by its shared code and recovery hint, as browserkit's tools name it. */
export function errorResult(error: unknown): ToolText {
  return textResult({ error: namedErrorText(error) }, true);
}

const safeName = (text: string): string =>
  text
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "result";

function previewOf(text: string): string {
  const cut = cutAtBoundary(text, PREVIEW_CHARS);
  if (!cut) return `[${text.length} characters; a preview would cut a string]`;
  if (cut.length === text.length) return text;
  return `${cut}\n…\n[${text.length} characters in all]`;
}

function inlineReply(text: string, full: boolean): string {
  return full || text.length <= PREVIEW_CHARS ? text : previewOf(text);
}

async function storedReply(
  value: unknown,
  text: string,
  workspace: string,
  folder: string,
  name: string,
  extension: string,
  full: boolean,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relative = join(folder, `${safeName(name)}-${stamp}.${extension}`).replace(/\\/g, "/");
  await mkdir(join(workspace, folder), { recursive: true });
  await writeFile(join(workspace, relative), text);
  if (!full) return `${relative}\n${previewOf(text)}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) return text;
  return JSON.stringify({ ...(value as Record<string, unknown>), savedIn: relative }, null, 1);
}

/** The value itself when small; otherwise the file path, then a preview that is not cut mid-string. */
export async function boundedResult(
  value: unknown,
  workspace: string | undefined,
  folder: string,
  name: string,
  extension = "json",
): Promise<ToolText> {
  const full = outputMode.getStore()?.full === true;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (text.length <= PREVIEW_CHARS || !workspace) return textResult(inlineReply(text, full));
  return textResult(await storedReply(value, text, workspace, folder, name, extension, full));
}
