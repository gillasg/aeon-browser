import type { ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";

type SignIn = ManagementSnapshotDto["signIn"];

/** Which password manager fills a site's sign-in form, and whether it is unlocked. */
export function PasswordManagerSettings(props: {
  signIn: SignIn | null;
  loading: boolean;
}): ReactElement {
  return (
    <section className="settings-group">
      <h2>Password manager</h2>
      <p>
        On a sign-in page the agent can ask your password manager to fill the form. It never sees
        the password or the one-time code.
      </p>
      <p>{props.loading && !props.signIn ? "Checking…" : describe(props.signIn)}</p>
      <p>
        Set it up in a terminal: <code>aeon signin setup bitwarden</code> or{" "}
        <code>aeon signin setup proton</code>. <code>aeon signin status</code> says which answers.
      </p>
    </section>
  );
}

function describe(signIn: SignIn | null): string {
  if (!signIn || signIn.state === "not_set_up") return "No password manager is set up yet.";
  if (!signIn.provider) return "No password manager answers right now.";
  const state =
    signIn.state === "unlocked"
      ? "unlocked"
      : signIn.state === "locked"
        ? "locked — unlock it before the agent signs in"
        : "not answering — check its command-line tool";
  return `${signIn.provider} · ${state}`;
}
