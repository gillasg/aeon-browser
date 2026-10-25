import type { ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { ActionNote } from "./management-automations.js";

// Site sessions: which sites have a stored session, and the three things the user needs from one
// place — clear it, sign in as another account, and read the site as a signed-out visitor.

type Site = NonNullable<ManagementSnapshotDto["sites"]>[number];

export function SiteSessionsPanel(props: ManagementSurfaceProps): ReactElement {
  const sites = props.snapshot?.sites ?? [];
  const chatId = props.selectedChatId || props.snapshot?.chats[0]?.chatId || "";
  return (
    <div className="management-sessions">
      <p className="management-hint">
        A stored session lets a site's API answer without opening the page. Clearing removes this
        machine's copy and the site's cookies; switching clears, opens the site and signs in with
        the password manager. Testing never signs you out: with a session still there it says so.
      </p>
      <ActionNote note={props.snapshot?.lastAction} />
      <div className="management-toolbar">
        <button type="button" onClick={props.onRefresh} disabled={props.loading}>
          Refresh
        </button>
      </div>
      {sites.length === 0 ? (
        <p className="management-empty">
          No mapped sites yet, so there are no sessions to manage. Map a site first.
        </p>
      ) : (
        <SessionsTable sites={sites} chatId={chatId} onAction={props.onAction} />
      )}
    </div>
  );
}

function SessionsTable({
  sites,
  chatId,
  onAction,
}: {
  sites: Site[];
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const stored = sites.filter((site) => site.session).length;
  return (
    <>
      <h2 className="management-subheading">
        {stored === 0 ? "No stored sessions" : `${stored} stored session${stored === 1 ? "" : "s"}`}
      </h2>
      <table className="management-table">
        <thead>
          <tr>
            <th scope="col">Site</th>
            <th scope="col">Session</th>
            <th scope="col">Account</th>
            <th scope="col">Saved</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => (
            <SessionRow key={site.site} site={site} chatId={chatId} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function SessionRow({
  site,
  chatId,
  onAction,
}: {
  site: Site;
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const act = (action: Parameters<typeof onAction>[1]) =>
    onAction(chatId, action, { site: site.site });
  return (
    <tr>
      <td>
        <strong>{site.site}</strong>
      </td>
      <td>
        {site.session ? (
          <span className="management-run-ok">Stored</span>
        ) : (
          <span className="management-subtle">Signed out</span>
        )}
      </td>
      <td>{site.sessionAccount ?? <span className="management-subtle">unknown</span>}</td>
      <td>
        {site.sessionSavedAt ? (
          formatWhen(site.sessionSavedAt)
        ) : (
          <span className="management-subtle">—</span>
        )}
      </td>
      <td>
        <SessionActions session={site.session} act={act} />
      </td>
    </tr>
  );
}

function SessionActions({
  session,
  act,
}: {
  session: boolean;
  act(action: "clear_site_session" | "switch_site_account" | "test_site_logged_out"): void;
}): ReactElement {
  return (
    <div className="management-actions">
      <button type="button" disabled={!session} onClick={() => act("clear_site_session")}>
        Clear session
      </button>
      <button type="button" onClick={() => act("switch_site_account")}>
        Switch account
      </button>
      <button type="button" onClick={() => act("test_site_logged_out")}>
        Test logged out
      </button>
    </div>
  );
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
