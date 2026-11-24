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
        footer="On a sign-in page Aeon asks your password manager to fill the form. The model never sees the password or the one-time code."
      >
        <ValueRow
          label="Fills sign-ins"
          value={status?.value ?? "Checking…"}
          {...(status?.detail ? { detail: status.detail } : {})}
          {...(status?.tone ? { tone: status.tone } : {})}
        />
      </SettingsGroup>
      <SettingsGroup
        title="When it can't"
        footer="No password manager, a locked vault or a captcha: Aeon stops on the sign-in page and hands it to you. You sign in, press I'm done, and it carries on."
      >
        <ValueRow label="Works with" value="Bitwarden · Proton Pass" />
      </SettingsGroup>
      <SettingsGroup
        title="This Chrome profile"
        footer="Aeon runs in your current Chrome profile, so Chrome's own saved passwords and passkeys (WebAuthn) work as they always do: Chrome fills them and you confirm. Aeon never stores a password in plain text."
      >
        <ValueRow label="Passkeys" value="Chrome's own prompt" />
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
    return {
      value: "Not set up",
      detail: "Until one is set up, Aeon hands sign-ins to you. Setup is in Advanced.",
    };
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
