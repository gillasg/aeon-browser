import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, dirname } from "node:path";
const run = promisify(execFile);
export async function readGitBase(path: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", dirname(path), "rev-parse", "--show-toplevel"], {
      timeout: 3000,
      maxBuffer: 1_048_576,
    });
    const root = stdout.trim();
    const name = relative(root, path).replaceAll("\\", "/");
    const result = await run("git", ["-C", root, "show", "HEAD:" + name], {
      timeout: 3000,
      maxBuffer: 1_048_576,
    });
    if (result.stdout.includes("\0")) return null;
    return result.stdout;
  } catch {
    return null;
  }
}
