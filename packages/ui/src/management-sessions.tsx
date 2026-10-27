import type { ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";

// Site sessions: which sites have a stored session, and the three things the user needs from one
// place — clear it, sign in as another account, and read the site as a signed-out visitor.

export function SessionActions({
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
