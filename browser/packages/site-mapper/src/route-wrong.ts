// Wrong drops the route that produced a result, or marks the ability stale, and records the
// correction as a quirk on that page type. The corrected path is not a route.

import { readAbility, saveAbility } from "./abilities.js";
import { dropRoute, stageRun } from "./route-store.js";
import type { ObservedStep } from "./route-types.js";
import { saveSiteNote } from "./site-notes.js";

export interface WrongReport {
  site: string;
  routeId?: string;
  abilityId?: string;
  pageType?: string;
  quirk: string;
  steps?: ObservedStep[];
  prompt?: string;
}

export async function reportWrong(
  report: WrongReport,
): Promise<{ droppedRoute: boolean; stale: boolean }> {
  const droppedRoute = report.routeId ? await dropRoute(report.site, report.routeId) : false;
  const stale = report.abilityId
    ? await markStale(report.site, report.abilityId, report.quirk)
    : false;
  const pageType = report.pageType || "correction";
  await saveSiteNote(report.site, {
    kind: "quirk",
    key: pageType.slice(0, 40),
    value: report.quirk.replace(/\s+/g, " ").trim().slice(0, 120),
  });
  if (report.steps?.length)
    await stageRun({
      site: report.site,
      prompt: report.prompt || report.quirk,
      steps: report.steps,
      corrected: true,
    });
  return { droppedRoute, stale };
}

async function markStale(site: string, abilityId: string, quirk: string): Promise<boolean> {
  const name = abilityId.includes("/") ? abilityId.slice(abilityId.indexOf("/") + 1) : abilityId;
  const ability = await readAbility(site, name);
  if (!ability || ability.createdBy === "builtin") return false;
  await saveAbility(
    {
      ...ability,
      stats: {
        ...ability.stats,
        stale: true,
        staleWhy: quirk.slice(0, 120),
      },
    },
    { check: false },
  );
  return true;
}
