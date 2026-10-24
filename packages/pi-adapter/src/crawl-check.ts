import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkSites, type SiteCheck } from "@browserkit/tools/browser-crawl";
import { crawlTool, type CrawlToolInput } from "@browserkit/tools/definitions";
import { boundedResult, type ToolText } from "./site-tool-output.js";

// crawl action=check: Aeon's override around the shared check handler is only the workspace
// evidence bundle; reading the input file and running the checks lives in browserkit.

type CheckInput = Pick<CrawlToolInput, "urls" | "file" | "limit" | "via" | "paths" | "expect">;

export async function runCheck(
  input: CheckInput,
  workspace: string | undefined,
): Promise<ToolText> {
  const report = (await crawlTool.run(
    { action: "check", ...input },
    { ...(workspace ? { workspace } : {}) },
  )) as Awaited<ReturnType<typeof checkSites>>;
  const saved = workspace ? await save(report.results, workspace) : undefined;
  const byVerdict: Record<string, string[]> = {};
  for (const result of report.results) (byVerdict[result.verdict] ??= []).push(result.host);
  return boundedResult(
    {
      checked: report.results.length,
      counts: report.counts,
      chromeUsed: report.browserUsed,
      chromePages: report.chromePages,
      spotCheck: report.spotCheck,
      ...(saved ? { savedIn: saved } : {}),
      ...(report.paths?.length ? { paths: pathSummary(report.paths) } : {}),
      hosts: byVerdict,
      note: "Each verdict's evidence (status, title, reason, http or chrome) is in the saved file.",
    },
    workspace,
    "checks",
    "summary",
  );
}

/** What the path probes found, host by host, with why the failing ones failed. */
function pathSummary(lines: NonNullable<Awaited<ReturnType<typeof checkSites>>["paths"]>) {
  return lines.map((line) => ({
    host: line.host,
    ok: line.ok,
    failed: line.failed,
    ...(line.expectation ? { expect: line.expectation } : {}),
    ...(line.failed
      ? {
          failing: line.probes
            .filter((probe) => !probe.ok)
            .slice(0, 3)
            .map((probe) => ({
              path: probe.path,
              shape: probe.shape,
              ...(probe.contentType ? { contentType: probe.contentType } : {}),
              ...(probe.reason ? { reason: probe.reason } : {}),
            })),
        }
      : {}),
  }));
}

async function save(results: readonly SiteCheck[], workspace: string): Promise<string> {
  const folder = join("checks", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(join(workspace, folder), { recursive: true });
  await writeFile(join(workspace, folder, "results.json"), JSON.stringify(results, null, 2));
  const rows = results.map((result) =>
    [
      result.host,
      result.verdict,
      result.via,
      result.status ?? "",
      result.title ?? "",
      result.reason ?? "",
    ]
      .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
      .join(","),
  );
  await writeFile(
    join(workspace, folder, "results.csv"),
    ["host,verdict,via,status,title,reason", ...rows].join("\n"),
  );
  return folder.replace(/\\/g, "/");
}
