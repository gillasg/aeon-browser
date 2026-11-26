import type { ReactElement } from "react";
import { ActionRow, AddRow, SettingsGroup, SwitchRow } from "./settings-list.js";

// Privacy: whether the agent may reach this computer and the local network, and the sites the
// password manager was told never to save logins for.

export interface PrivacyState {
  /** True when the agent is kept off local and private-network addresses (opt-in). */
  privateNetwork: boolean;
  /** Ports on this computer the agent may still reach while it is kept off the network. */
  ports: readonly number[];
  /** Sites the password manager never offers to save a login for. */
  neverSave: readonly string[];
  /** Where new background tabs the agent opens go: its own unfocused window or this window's group. */
  tabPlacement?: "background-window" | "current-window-group";
}

export interface PrivacySettingsProps {
  state: PrivacyState;
  onPrivateNetwork(enabled: boolean): void;
  onPorts(ports: number[]): void;
  onNeverSaveRemove(site: string): void;
  onTabPlacement?(placement: "background-window" | "current-window-group"): void;
}

function parsePort(value: string): number | undefined {
  const port = Number(value.trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function TabPlacementSettings(props: PrivacySettingsProps): ReactElement | null {
  const onTabPlacement = props.onTabPlacement;
  if (!onTabPlacement) return null;
  return (
    <SettingsGroup
      title="Background tabs"
      footer="Off opens them, inactive, in this window's Aeon tab group. Aeon never takes over the tab you are on."
    >
      <SwitchRow
        label="Open background tabs in a separate window"
        checked={(props.state.tabPlacement ?? "background-window") === "background-window"}
        onChange={(on) => onTabPlacement(on ? "background-window" : "current-window-group")}
      />
    </SettingsGroup>
  );
}

export function PrivacySettings(props: PrivacySettingsProps): ReactElement {
  const { state, onPorts } = props;
  return (
    <>
      <TabPlacementSettings {...props} />
      <SettingsGroup
        title="Privacy"
        footer="Stops a web page from steering Aeon into your router or local apps. Allow the ports you use for local development."
      >
        <SwitchRow
          label="Keep Aeon off this computer and your local network"
          checked={state.privateNetwork}
          onChange={props.onPrivateNetwork}
        />
        {state.privateNetwork && (
          <>
            {state.ports.map((port) => (
              <ActionRow
                key={port}
                label={`localhost:${port}`}
                action="Remove"
                onClick={() => onPorts(state.ports.filter((item) => item !== port))}
              />
            ))}
            <AddRow
              label="Allowed local port"
              placeholder="Allow a port, e.g. 3000"
              action="Allow"
              inputMode="numeric"
              valid={(value) => {
                const port = parsePort(value);
                return port !== undefined && !state.ports.includes(port);
              }}
              onAdd={(value) =>
                onPorts([...state.ports, parsePort(value) ?? 0].sort((left, right) => left - right))
              }
            />
          </>
        )}
      </SettingsGroup>
      {state.neverSave.length > 0 && (
        <SettingsGroup
          title="Never save logins for"
          footer="Your password manager won't offer to save logins on these sites."
        >
          {state.neverSave.map((site) => (
            <ActionRow
              key={site}
              label={site}
              action="Remove"
              onClick={() => props.onNeverSaveRemove(site)}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  );
}
