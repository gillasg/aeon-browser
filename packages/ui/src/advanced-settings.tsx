import type { ReactElement } from "react";
import { developerModeKey, useAgentFlag } from "./agent-tab-view.js";
import { ImportPath } from "./management-sites.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { SettingsGroup, SwitchRow, ValueRow } from "./settings-list.js";

// Advanced: the one place for internals. Developer mode, site-pack import and the CLI.

export function AdvancedSettings({
  chatId,
  onAction,
}: {
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const [developer, setDeveloper] = useAgentFlag(developerModeKey);
  return (
    <div className="settings-groups">
      <SettingsGroup title="Developer">
        <SwitchRow
          label="Developer mode"
          detail="Shows Pi's tools and the context ring in the side panel's composer."
          checked={developer}
          onChange={setDeveloper}
        />
      </SettingsGroup>
      <SettingsGroup title="Site packs">
        <li className="settings-row">
          <ImportPath chatId={chatId} onAction={onAction} />
        </li>
      </SettingsGroup>
      <SettingsGroup
        title="Command line"
        footer="The aeon command does everything Manage does, from a terminal or another agent."
      >
        <ValueRow label="Run a skill" value={<code>aeon abilities run</code>} />
        <ValueRow label="Change agent settings" value={<code>aeon settings set</code>} />
        <ValueRow label="Set up Bitwarden" value={<code>aeon signin setup bitwarden</code>} />
        <ValueRow label="Set up Proton Pass" value={<code>aeon signin setup proton</code>} />
      </SettingsGroup>
    </div>
  );
}
