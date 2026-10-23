import { join } from "node:path";
import { getSavedRead, putSavedRead, siteMapperRequest } from "@aeon/pi-adapter";

// Requests from Aeon's own extension (never forwarded from other extensions) about the site in
// a tab: the operations a site learned (the orb's chips), learning while the user browses a tab
// they switched on, a write repeated for Undo, and saved reads for "changed since you last
// looked". No model is involved in any of them.

const SESSION = "aeon-browsing";
let savedReads: string | undefined;

/** Where saved reads live: beside site skills, in the data folder. */
export function configureSiteRequests(dataRoot: string): void {
  savedReads = join(dataRoot, "saved-reads");
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`A site request needs ${what}`);
  return value;
};

function site(request: Record<string, unknown>): Promise<unknown> {
  const pending = siteMapperRequest(SESSION, request);
  if (!pending) throw new Error("Unsupported site request");
  return pending;
}

function values(data: Record<string, unknown>): Record<string, unknown> {
  return typeof data.params === "object" && data.params
    ? (data.params as Record<string, unknown>)
    : {};
}

export async function answerSiteRequest(data: Record<string, unknown>): Promise<unknown> {
  const action = data.action;
  if (action === "operations")
    return site({ siteMapper: "operations", site: text(data.site, "the site") }).catch(() => []);
  if (action === "learn")
    return site({ siteMapper: "learn-live", site: text(data.site, "the site"), har: data.har });
  if (action === "write")
    return site({
      siteMapper: "write",
      site: text(data.site, "the site"),
      operation: text(data.operation, "the operation"),
      params: values(data),
    });
  if (action === "undo")
    return site({
      siteMapper: "undo",
      site: text(data.site, "the site"),
      operation: text(data.operation, "the operation"),
      params: values(data),
    });
  if (!savedReads) throw new Error("Saved reads are unavailable");
  if (action === "read.get")
    return (await getSavedRead(savedReads, text(data.url, "the page"))) ?? null;
  if (action === "read.seen")
    return {
      saved: await putSavedRead(savedReads, text(data.url, "the page"), String(data.text ?? ""), {
        onlyIfKnown: true,
      }),
    };
  throw new Error(`Unknown site request: ${String(action)}`);
}
