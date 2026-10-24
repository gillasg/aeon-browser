import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkSites, type SiteCheck } from "@browserkit/tools/browser-crawl";
import { boundedResult, type ToolText } from "./site-tool-output.js";

// crawl action=check: which of many sites load. Plain HTTP first, then the user's Chrome for
// anything plain HTTP cannot settle, with a few successes re-checked in Chrome. Every verdict is
// saved with its evidence; the reply is the counts and the hosts per verdict.

export async function runCheck(
  input: { urls?: string[] | undefined; file?: string | undefined; limit?: number | undefined },
  workspace: string | undefined,
): Promise<ToolText> {
  const urls = [...(input.urls ?? []), ...(await urlsFromFile(input.file, workspace))];
  if (!urls.length) throw new Error("Give urls (hosts or URLs) or a workspace file listing them");
  const report = await checkSites(urls.slice(0, 5000));
  const saved = workspace ? await save(report.results, workspace) : undefined;
  const byVerdict: Record<string, string[]> = {};
  for (const result of report.results) (byVerdict[result.verdict] ??= []).push(result.host);
  return boundedResult(
    {
      checked: report.results.length,
      counts: report.counts,
      chromeUsed: report.browserUsed,
      spotCheck: report.spotCheck,
      ...(saved ? { savedIn: saved } : {}),
      hosts: byVerdict,
      note: "Each verdict's evidence (status, title, reason, http or chrome) is in the saved file.",
    },
    workspace,
    "checks",
    "summary",
  );
}

async function urlsFromFile(file: string | undefined, workspace: string | undefined) {
  if (!file) return [];
  const path = workspace ? resolve(workspace, file) : resolve(file);
  if (workspace && !path.startsWith(resolve(workspace)))
    throw new Error("The file must be in this chat's workspace");
  const text = await readFile(path, "utf8");
  try {
    const value = JSON.parse(text) as unknown;
    const items = Array.isArray(value) ? value : Object.values(value as object).flat();
    return items.map((item) =>
      typeof item === "string"
        ? item
        : String(
            (item as { host?: string; url?: string }).url ?? (item as { host?: string }).host ?? "",
          ),
    );
  } catch {
    return text.split(/\s+/);
  }
}

async function save(results: readonly SiteCheck[], workspace: string): Promise<string> {
  const folder = join("checks", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(join(workspace, folder), { recursive: true });
  await writeFile(join(workspace, folder, "results.json"), JSON.stringify(results, null, 2));
  const rows = results.map((r) =>
    [r.host, r.verdict, r.via, r.status ?? "", r.title ?? "", r.reason ?? ""]
      .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
      .join(","),
  );
  await writeFile(
    join(workspace, folder, "results.csv"),
    ["host,verdict,via,status,title,reason", ...rows].join("\n"),
  );
  return folder.replace(/\\/g, "/");
}
