import type { SiteScriptRecord } from "@aeon/domain";
import type { Rewind, SiteScriptCommand } from "@aeon/protocol";

/**
 * How to take back a change to a site script: go back to its earlier revision. Only a change
 * that left an earlier revision to return to has one, and undoing is not itself rewound.
 * `revision` is the one `undo` must name (`expectedRevision`), so a later edit cannot be undone
 * by mistake from a stale receipt.
 */
export function siteScriptRewind(
  script: Pick<SiteScriptRecord, "scriptId" | "name" | "revision" | "history">,
  action: SiteScriptCommand["action"],
): Rewind | undefined {
  if (action === "undo" || action === "delete" || !script.history.length) return undefined;
  return {
    kind: "site-script-undo",
    scriptId: script.scriptId,
    revision: script.revision,
    label: `Undo change to ${script.name}`.slice(0, 160),
  };
}
