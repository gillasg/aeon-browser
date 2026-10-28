import type { ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import { SettingsGroup, ValueRow } from "./settings-list.js";

type SignIn = ManagementSnapshotDto["signIn"];

/** Which password manager fills a site's sign-in form, and whether it is unlocked. */
export function PasswordManagerSettings(props: {
  signIn: SignIn | null;
  loading: boolean;
}): ReactElement {
  const status = props.loading && !props.signIn ? null : describe(props.signIn);
  return (
    <div className="settings-groups">
      <SettingsGroup
        title="Password manager"
        footer="On a sign-in page Aeon asks your password manager to fill the form. Aeon never sees the password or the one-time code."
      >
        <ValueRow
          label="Fills sign-ins"
          value={status?.value ?? "Checking…"}
          {...(status?.detail ? { detail: status.detail } : {})}
          {...(status?.tone ? { tone: status.tone } : {})}
        />
      </SettingsGroup>
      <SettingsGroup title="Set up">
        <ValueRow label="Bitwarden" value={<code>aeon signin setup bitwarden</code>} />
        <ValueRow label="Proton Pass" value={<code>aeon signin setup proton</code>} />
      </SettingsGroup>
    </div>
  );
}

function describe(signIn: SignIn | null): {
  value: string;
  detail?: string;
  tone?: "needs" | "ok";
} {
  if (!signIn || signIn.state === "not_set_up")
    return { value: "Not set up", detail: "Pick one below, in a terminal." };
  if (!signIn.provider) return { value: "Not answering", tone: "needs" };
  const name = signIn.provider[0]?.toUpperCase() + signIn.provider.slice(1);
  if (signIn.state === "unlocked") return { value: `${name} · Unlocked`, tone: "ok" };
  if (signIn.state === "locked")
    return {
      value: `${name} · Locked`,
      detail: "Unlock it before Aeon signs in for you.",
      tone: "needs",
    };
  return {
    value: `${name} · Not answering`,
    detail: "Check that its command-line tool is installed.",
    tone: "needs",
  };
}
